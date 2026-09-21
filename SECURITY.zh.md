# 安全政策

[English](SECURITY.md) | 中文

## 报告漏洞

请通过
[GitHub Security Advisories](https://github.com/BOWLUNA/dsh-zcode-git/security/advisories/new)
私下报告。漏洞请不要开公开 issue。

一份有用的报告包含：

- 受影响的版本（`npm view dsh-zcode-git version`，或你实测的 commit）；
- 最小复现 —— 工具调用、当时的仓库状态、以及实际发生了什么；
- 你认为的影响面。

这是一个小项目，没有专职安全团队维护。请预期几天内而不是一小时内得到回应；
若你打算公开披露，也请直接说明，以便商定时间线。

## 威胁模型

dsh 的 profile 插件是**静态安装、无沙箱的受信代码**：它运行在 harness 进程内，
持有 harness 的权限，可以随意起进程、读文件。这是平台的设计，不是本插件的特性；
也正因为如此，真正有意思的问题不是「这个插件能不能造成破坏」（它当然能，任何插件都能），
而是**它替模型拒绝了哪些破坏**。

### 本插件防御什么

- **对模型提供的文本做 shell 解释。** 每次 git 调用都是一个 argv 数组，交给
  `ctx.subprocess.spawn`。全程不构造命令行，因此提交信息或路径里的 `"`、反引号、
  `$(...)`、`%PATH%`、`&`、`;`、`|`、换行都不可能被重新解释。这在 Windows 上尤其重要 ——
  cmd.exe 在双引号内部仍展开 `%VAR%`，而**不存在**一条同时覆盖 cmd.exe、PowerShell
  与 POSIX sh 的转义规则。
- **路径逃逸。** 绝对路径、`..` 穿越（两种分隔符都查）、UNC 路径、`C:foo` 这类驱动器
  相对形式、NTFS 备用数据流、Windows 保留设备名与控制字符，都在进程启动之前被拒绝。
  git 自己也会拦大部分，但先校验能让明显敌意的输入连进程都不进，并给出精确消息
  而不是 exit 128。
- **未经请求的写入。** `git_commit` 以及 `git_branch`、`git_stash` 的写入动作走
  `ctx.approval.request()`。**没有装审批服务时一律拒绝**，而不是放行 ——
  「静默无保护的 `git commit`」正是本插件要消除的那种结果。
- **输出形态被操纵。** 输出由 10 项 `git -c` 覆盖钉死，因此仓库级或全局设置
  （`color.ui=always`、`diff.external=<程序>`、`core.pager=<程序>`、
  `status.relativePaths`）既不能把转义序列注入解析结果，也不能把输出导向仓库指定的程序。
- **静默摧毁。** `push`、`fetch`、`pull`、`reset`、`clean`、`rebase`、`remote`
  与 config 写入一概不提供。

### 本插件不防御什么

- **被同时加载的恶意插件。** profile 插件共用一个进程、一个 context。请只装你信任的插件。
- **PATH 上更靠前的恶意 `git`。** 二进制由 subprocess 接缝按正常 PATH 顺序解析。
- **仓库里会执行代码的 hook、filter 或 attributes。** `core.hooksPath`、
  `filter.*.clean`、`diff.external` 以及 `.gitattributes` 过滤器都会运行仓库提供的程序。
  钉死的配置只中和了本插件自身调用中的 `diff.external`，仓库仍可能借其它 git 特性触发
  代码执行。克隆不受信任的仓库时，请保持与本插件之外同样的警惕。
- **文件系统可达范围。** 显式的绝对 `path` 参数会被执行，与 `bash` 一致。一次会话能读什么、
  写什么，边界在 harness 的沙箱与审批策略，不在这个工具。
- **仓库中的机密。** 读到含凭据的文件并把它复述进对话，是模型的行为，本插件不做管制。

## 支持范围

| 版本 | 支持 |
| --- | --- |
| `1.0.0` | ✅ |
| 更早的版本 | ❌ |

只支持最新发布版本。本插件独立于 harness 版本号，并在 `package.json` 的
`engines.dsh` 里声明兼容范围；`node tools/verify-version-consistency.mjs`
会检查该范围是否仍覆盖测试矩阵跑过的每个 harness 版本。
