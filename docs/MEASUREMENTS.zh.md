# 实测记录

[English](MEASUREMENTS.md) | 中文

本页每一条结论都带着产生它的命令。README 里的数字也是一种主张，而本仓库的规矩是
**主张要被检查，而不是被记住**。

## 测试套件

```console
$ node test/run.mjs
suites: 6
# tests 95
# pass 95
# fail 0
结果: 95 通过, 0 失败
```

六层，按「只有这一层能抓到什么」划分：

| 层 | 文件 | 只有这一层能看见的失败 |
| --- | --- | --- |
| 解析器 | `test/parse.test.js` | 含空格的路径被切成两条记录 |
| 校验 | `test/validate.test.js` | `..\..\x` 从只查 `/` 的穿越检查下溜过去 |
| spawn 规格 | `test/exec.test.js` | argv 数组又悄悄变回了命令字符串 |
| 工具行为 | `test/tools.test.js` | 渲染器读了 `execute` 从未返回的字段 |
| schema | `test/schema.test.js` | 某个 harness 版本会拒绝的 schema 关键字 |
| 端到端 | `test/e2e.test.js` | 一个想当然的 git 格式假设（见下） |

最后一行是有来历的：`git branch --format` 用的是 **for-each-ref** 转义语法（`%1f`），
不是 `git log` 的 `%xXX`。写错时 git 会**原样输出字面量 `%x1f`**，于是任何字段都切不开，
所有分支都被过滤掉 —— 静默地，没有任何报错。照着同一个错误假设写的单元测试会全部通过。
只有真实的 git 二进制能抓到它。

## 跨平台结果

| 平台 | 命令 | 结果 |
| --- | --- | --- |
| Windows | `node test/run.mjs` | 95 / 95 通过 |
| Linux（WSL） | `node test/run.mjs` | 92 通过、1 跳过、0 失败 |

那一条跳过的是 `validateRepoRelativePath applies the Windows-only hazards on
Windows` —— 备用数据流与保留设备名在 Linux 上没有对应物，所以该用例**如实标记为跳过**，
而不是空泛地通过。

## 验收：用户的配置无法改变输出形态

被测仓库里设了 `color.ui=always`、`status.relativePaths=true`、`core.quotepath=true`
与一个 alias，然后创建一个中文名文件和一个带空格的文件：

```console
$ node --test test/e2e.test.js
ok 4 - acceptance 5 — the user's git configuration cannot reshape the output
```

断言是：没有任何路径含 `../`，任何输出都不含 ANSI 转义（`\u001b[`），
且中文文件名以 `café.txt` 原样返回，而不是八进制转义。

## 验收：提交信息被逐字节存入

消息写入后，**从仓库里读回来**比对：

```console
$ node --test test/e2e.test.js
ok 5 - acceptance 6 — a commit message with shell metacharacters is stored verbatim
ok 6 - acceptance 6 — a message that is only metacharacters still survives
```

第一个用例用了 `%PATH%`、`$(whoami)`、`"`、反引号、换行与中文；
第二个整条消息全是元字符。两者都比对 `git log -1 --format=%B`，
而不是比对工具自己的回显。

## 真实会话：模型自己选工具

任务文本**从不提及任何工具名**。模型自己选了三个，会话日志就是证据：

```console
$ node session-trace.mjs --home ~/.dsh --session <id> --summary
会话 …：38 条记录，4 次工具调用
     1 × git_status   1 × git_diff   1 × git_log   1 × git_branch
```

计数器可能「永真」，所以这条检查带**反向对照** —— 断言一个并不存在的工具，必须失败：

```console
$ --expect 'git_status=1'   → exit 0
$ --expect 'git_push=1'     → exit 1   (没有这个工具)
```

## 实测实验室

下面每个数字都取自本项目**自己的** harness 实例，不是共享实例，且都可复现：

```console
$ export DSH_INSTALL="<harness 根目录>"     # 其下有 node_modules/@deepseek-ai/dsh
$ node tools/boot-check.mjs --port 32070  # 一次真启动，四条断言
```

| | |
| --- | --- |
| harness | `@deepseek-ai/dsh@0.1.6-alpha.2` |
| node | v22.22.2 |
| 端口 | 32070（本项目自己的号段） |
| 真启动自检 | exit 0 · 4375 毫秒 · A/B/C/D 全通过 · `C: held for 2000ms` · `D: 0 bytes` |
| `--dump-config` | exit 0 · 568 行 · stderr 0 字节 |

脚本里**没有任何机器专属路径**：`DSH_INSTALL` 是唯一指向 harness 的方式 ——
所以这一节描述的是一份实例，而不是写死一个路径。

## 规模实测

「已知缺口」里原先写着三项从未测过的东西。下面四个数字来自同一次运行：

```console
$ node tools/measure.mjs --large-files 3000 --concurrency 8 --big-mb 10
```

**哪些是真的，哪些是替身。** 插件自己的路径是真的（`defineTools` → 各工具的 `execute` → `runGit`），
`git` 二进制是真的，操作系统进程、abort 阶梯、文件系统、时钟也都是真的。
`ctx.subprocess` 服务是**替身**：生产实现是一个在 harness 之外无法构造的 cordis 服务，
所以 `tools/measure.mjs` 自己实现了那份**有成文定义的接缝** —— argv 数组、`cwd`、`env`、
每流一个 `{maxBytes, spill}`、`graceMs` 与 abort 信号。
每个数字都读作「**插件的行为**，已实测」，**不要**读作「生产 subprocess 服务，已实测」。

### 大仓库

| | |
| --- | --- |
| 改动文件数 | 3000 |
| `git_status` 报出的文件数 | 3000 |
| 墙钟时间 | **40 毫秒** |
| git 原始 stdout | **377 963 字节** |
| 渲染后文本 | 56 919 字节 |
| 流是否触到 8 MiB 上限 | 否 |
| 起的 git 进程数 | 1 |
| 工具构造出的 argv | `--porcelain=v2 --branch --untracked-files=all -z` |

有意思的是这两个大小：3000 条改动路径进来是 378 KB 的 porcelain，出去是 57 KB 的结构化文本，
而且是**完整的**。这个规模下没有任何截断，所以原先那句「只有单元级断言」是名副其实的缺口 ——
`clampInteger` 在这里根本不会触发。

### 溢出（spill）路径

| | |
| --- | --- |
| 生成的补丁 | **22 649 443 字节**（21.6 MiB） |
| `--numstat` | `209716  209716  big.txt` |
| 单流上限 | 8 MiB |
| 接缝保留 | **8 388 608 字节** —— 恰好等于上限 |
| 接缝溢写到磁盘 | **14 260 835 字节** |
| 保留 + 溢出 | 22 649 443 字节 —— 整份补丁，一个字节没丢 |
| 工具报出的 `truncated` | **true** |
| 工具交出的补丁 | 269 844 字节 |
| 渲染后 | 270 035 字节 |
| 溢出路径是否交给模型 | **是** |
| 墙钟时间 | 698 毫秒 |

21.6 MiB 的补丁撞 8 MiB 的单流上限：接缝恰好保留到上限、其余溢写，
两者相加**逐字节**等于补丁总长。工具**如实报出** `truncated: true` 而不是静默交一个前缀，
并告诉模型完整输出在哪 —— 最终到模型手上的是 264 KB 而不是 21.6 MB。

### 并发

`isConcurrencySafe` 原先只是一个声明；这一节把它练了一遍。

| | |
| --- | --- |
| 并行 `git_status` 调用数 | 8 |
| 串行墙钟 | 197 毫秒 |
| 并行墙钟 | **54 毫秒** |
| 每个并行结果与串行逐字节相同 | **true** |
| 八个结果的不同哈希数 | 1 |
| 不同子进程 pid 数 | 16（8 串行 + 8 并行） |

每次调用有自己的 `git` 进程和自己的缓冲，所以结果不会互相串。
墙钟快 4 倍是附带的；要点是那八个结果与串行基线**哈希相同**。

### 超时后的进程回收

超时是用 abort 表达的，所以真正的问题是：之后那个 `git` 子进程到底还在不在。
这一条走 `runGit` 驱动（它是持有该 deadline 的那一层 —— 工具会把失败转成模型可读的形状，
而那个形状里没有 `timedOut`）：

| | |
| --- | --- |
| `timeoutMs` | 1 |
| `runGit` 报出的 `timedOut` | **true** |
| `runGit` 看到的 exit / signal | `null` / `SIGTERM` |
| `runGit` 返回耗时 | 8 毫秒 |
| 子进程消失耗时 | **8 毫秒** |
| `reaped` | **true** |

1 毫秒的 deadline 下，子进程被终止、`runGit` **如实说明**（而不是报一个裸失败），
且该进程在同一个毫秒内可观测为已消失 —— 这正是接缝那套 `graceMs` 阶梯的用途。

## argv 数组 vs 命令行

整个设计就压在这个对照上，所以它是**测出来**的，不是断言的。
一条「恶意」提交信息 —— `%PATH%`、`$(echo pwned)`、`` `id` ``、两种引号、一个换行 —— 两种送法：

| | argv 数组（本插件） | `bash -c "git commit -m \"…\""` |
| --- | --- | --- |
| 送出的字节 | 114 | 114 |
| git 实际收到的字节 | **114** | **144** |
| 逐字节往返 | **是** | **否** |
| git 里存下的内容的 sha256 | `1ad1f3379f68c256` | `c22c39104c8c3d2e` |
| 送出内容的 sha256 | `1ad1f3379f68c256` | ——（不同） |

shell 那条路真正写进提交信息的内容，从仓库里读回来是这样：

```
subject with %PATH% and pwned and uid=197609(BOWLUNA) gid=197121 groups=197121
```

`$(echo pwned)` 变成了 `pwned`，`` `id` `` 变成了 `id` 的真实输出 ——
**本机的账号 uid 与组 gid 被写进了提交信息**。这正是本插件存在的意义所在，
而 argv 那一行说明了它为什么不可能发生。

## 已知缺口

- **子目录下的路径基准。** 2026-09-22 实测，而且这是**缺陷**不是缺口：会话 `cwd` 位于子目录时，
  `git_status` 与 `git_diff` 交出的是**仓库根相对**路径，而模型的工作基准是当前工作目录。
  把那些路径原样喂回去会得到 `ok: true, files: [], message: ""` —— 静默地什么都没有。
  复现与修法见
  `plugins/git/dsh-zcode-git/issues/GIT-4-子目录下路径基准不一致.md`；
  与「已解决它的那份实现」的对照在 README 的 ZCode 一节。
- **生产 subprocess 服务本身没有被测。** 「规模实测」里每个数字跑的都是
  `ctx.subprocess` 的忠实替身，不是 `@deepseek-ai/dsh-subprocess-local`。
  因此凡是依赖真接缝的溢出文件格式、job object 语义或 Windows runner 的数字，都不在覆盖范围内。
- **并发只测到 8，且只在一台机器上。** 声明被练过、结果与串行一致；
  至于一台负载很高的机器上 64 路并行会怎样，这里什么都没说。
- **没有针对「历史很深」的仓库的测量。** 大仓库那些数字说的是工作树规模（3000 个改动文件），
  不是在一个很深的提交历史上跑 `git log`。
