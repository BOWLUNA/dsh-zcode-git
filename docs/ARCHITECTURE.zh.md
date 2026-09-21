# 架构

[English](ARCHITECTURE.md) | 中文

本插件为什么这样写。简短版在 [README](../README.zh.md)；这份文件记录推理与约束，
包括那些花掉一整个调试会话的约束。

## 一个决定，其余都是它的推论

harness 的 agent 本来就能跑 git —— 通过 `bash`。本插件存在，是因为那条路有三个
**无法在一条 shell 命令内部修好**的性质：

1. **输出的形态属于用户的配置，不属于工具。** `git status`、`git diff`、`git log`
   是为人读终端而渲染的。它们的精确字节取决于 `color.ui`、`core.pager`、
   `core.quotepath`、`status.relativePaths`、`diff.external`、`diff.noprefix`、
   `diff.mnemonicPrefix`、`log.showSignature` 与 `log.date`。照着作者机器上的输出写的解析器，
   换一台把这些设成别样的机器就会坏 —— 而且是**静默地**坏：工具给出一个看似合理的错误答案，
   而不是报错。
2. **参数必须先活过 shell。** `git commit -m "<消息>"` 意味着这条消息要按宿主经过
   cmd.exe、PowerShell 或 POSIX sh。三者的转义规则互不相同，而且**没有任何一个**会碰巧
   保住 `%PATH%`、`$(...)`、反引号或换行。这在 Windows 上不是理论担忧：cmd.exe 在双引号
   **内部**依然展开 `%VAR%`。
3. **读和摧毁是同一个工具。** 在 `bash` 里，`git status` 与 `git push --force` 的区别只是
   敲进去的文字。harness 的审批层看到的是一个叫 `bash` 的工具，分辨不出这两者。

下面每一条，都是在解决这三个问题。

## 绝不经过 shell

每次调用都构造成一个 **argv 数组**，交给 `ctx.subprocess.spawn`。shell 从不解析任何参数，
于是也就没有什么需要转义。

harness 提供两个进程接缝，在它们之间做选择就是整个论证：

| 接缝 | 请求形态 | 需要转义吗 |
| --- | --- | --- |
| `ctx.shell` | 一整行命令（字符串） | 需要 —— 而且没有一条规则能同时覆盖 cmd.exe、PowerShell 与 POSIX sh |
| `ctx.subprocess` | argv 数组 | 不需要 |

`ctx.shell` 对于「用途就是执行 shell 命令」的工具是正确的接缝。而对于「用途是用已知参数
执行一个已知程序」的工具，它只增加了一个解析问题，没带来任何能力。所以 `src/exec.js`
用的是 `ctx.subprocess`。

一个值得写下来的后果：含 `"`、`` ` ``、`$(rm -rf /)`、`%PATH%`、换行或中文的提交信息会
**逐字节**送到 git；端到端套件证明这一点的办法是**把消息从仓库里读回来**，而不是断言
「调用成功了」。

## 输出是被钉死的，不是靠宽容解析

每次调用都用 `-c key=value` 强制覆盖十项配置，紧跟 `git` 之后，从而压过所有配置文件：

| 配置 | 不钉死它会怎样 |
| --- | --- |
| `color.ui=false` | 把 ANSI 转义序列灌进捕获的输出 |
| `core.pager=cat` | 起一个分页器，其子进程会一直占着管道 |
| `core.quotepath=false` | 把 `文档.txt` 渲染成 `"\346\226\207..."` |
| `status.relativePaths=false` | 让 status 的路径相对进程 cwd，而不是仓库根 |
| `log.showSignature=false` | 往 log 输出里塞签名块 |
| `log.date=default` | 跟随用户的日期格式 |
| `diff.noprefix=false` | 去掉 `a/`…`b/` 前缀 |
| `diff.mnemonicPrefix=false` | 把那两个前缀换成 `i/`/`w/`/`c/` |
| `diff.external=` | 把 diff 交给仓库指定的某个程序 |
| `advice.detachedHead=false` | detached HEAD 时往 stderr 加一段提示 |

**行为类**配置则刻意**不**覆盖。`user.name`、`user.email`、`core.autocrlf`、
`core.sshCommand` 与 hook 配置是用户的意图，不是噪声 —— 覆盖它们会让工具用错误的身份提交，
或无视仓库的行尾策略。

凡是 git 提供机器格式的地方就用机器格式，人读格式一概不解析：status 用
`--porcelain=v2 -z`，diff 用 `--numstat -z`，log 用 NUL 与 `%x1f` 的记录格式，
分支用 `for-each-ref` 字段语法。

## 模块划分

```
index.js              工具定义：schema、execute、render、presentationMeta
cordis.patch.yml      本包插入的那一行 profile 行
src/exec.js           spawn spec 构造、钉死的配置与环境、工作目录解析
src/parse.js          git 机器格式的纯解析器
src/validate.js       纯输入校验
src/render.js         纯渲染器，面向模型的文本
test/                 六层，见 test/README.md
tools/                三道守卫与一个 peer 链接助手
```

划分沿一条线：`parse.js`、`validate.js`、`render.js` 是**纯函数**，没有 I/O、不依赖 harness，
所以它们可以在没有仓库的情况下被穷尽测试。`exec.js` 是唯一碰进程接缝的模块，
`index.js` 是唯一碰 harness 的模块。

## 审批

`git_commit` 以及 `git_branch`、`git_stash` 的写入动作，在执行任何东西之前调用
`ctx.approval.request()`。决定必须回 `allowed-once`，其它一律中止。

**没有装审批服务时，写操作被拒绝**，而不是放行。一个静默无保护的 `git commit` 正是本插件
要消除的结果，所以 fail closed 是唯一自洽的默认。确实没有审批层的 profile 可以用
`requireApprovalForWrites: false` 退出这条 —— 那是一个刻意的决定，而不是意外。

## 刻意不提供的

`push`、`fetch`、`pull`、`reset`、`clean`、`rebase`、`remote`，以及配置写入。

在 `bash` 里，这些至少还躺在一行人类按回车前能读到的命令里。做成工具，它们就变成
「一次调用摧毁一切、只靠一个提示框把关」，而误用 `reset --hard` 的失败模式是不可恢复的工作丢失。
fetch 与 push 还额外牵涉凭据与主机密钥处理，值得单独设计，而不是在这里加个复选框。

这是范围决定，不是技术限制。`ctx.subprocess` 完全能跑它们。

## 兼容性

本插件声明 `engines.dsh: ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0"`，并在 Linux 与 Windows 上对
`0.1.5-rc.2`（稳定线）与 `0.1.6-alpha.2`（预览线）都做过测试。这两个 harness 版本之间
存在对工具插件有实质影响的差异：

- property 内的 `required: true`：`0.1.5-rc.2` 接受，`0.1.6-alpha.2` 拒绝。
- 顶层的 `required: [...]` 数组：两者都拒绝。

因此本插件一个都不声明，而是在 `execute` 里强制同样的约束。完整清单见
[`AGENTS.md`](../AGENTS.md)。
