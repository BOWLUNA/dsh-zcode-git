# dsh-zcode-git

[English](README.md) | 中文

给 DeepSeek Harness 智能体用的**一等公民 Git 工具**。

DSH 本身没有任何 git 工具，模型只能通过 `bash` 手搓命令。这个插件注册六个结构化工具，
并解决 `bash` 路线的三个根本问题：

| 用 `bash` 的问题 | 本插件的做法 |
| --- | --- |
| 输出形态随用户配置变化（`color.ui`、`core.pager`、`core.quotepath`、`diff.external`、`status.relativePaths`、alias） | 每次调用都钉死这些配置，并解析 porcelain / NUL / `%x1f` 等机器可读格式 |
| `git commit -m "..."` 要同时活过 cmd.exe、PowerShell 与 POSIX sh —— 三者转义规则不同，且都不会「碰巧」保住 `%PATH%`、`$(...)` 或换行 | 构造 **argv 数组**：参数根本不经过任何 shell |
| 在 `bash` 里，`git status` 与 `git push --force` 权限一样大 | 读操作与写操作分开，写操作走 harness 的审批服务 |

## 环境要求

- DeepSeek Harness `>=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0` —— 同一范围也声明在 `engines.dsh`
- Node `>=20`，harness 自带的那份运行时即满足
- `PATH` 上有一个 `git` 二进制

## 安装

```bash
dsh plugin --profile web add dsh-zcode-git
```

包自带 patch 声明，profile 的 `bundles` 会自动更新。装完**重启 Harness** —— bundle 层在启动时读取。

手工挂载：

```yaml
# cordis.patch.yml
- insert:
    - id: tool-git
      name: dsh-zcode-git
```

## 工具清单

| 工具 | 类型 | 作用 |
| --- | --- | --- |
| `git_status` | 读 | 分支、upstream、ahead/behind，以及 staged / modified / conflicted / untracked / ignored 五类清单 |
| `git_diff` | 读 | 逐文件行数统计 + unified diff，可用 `paths`、`staged`、`contextLines` 收窄 |
| `git_log` | 读 | 提交记录，返回 `{hash, shortHash, author, date, subject}`，`limit` 限流，`paths` / `revision` 过滤 |
| `git_branch` | 读 + 写 | `list` / `create` / `switch` / `delete`；写操作需审批 |
| `git_commit` | 写 | 可选先 `paths` 暂存，再提交 `message`；需审批 |
| `git_stash` | 读 + 写 | `list` / `push` / `pop` / `apply` / `drop`；写操作需审批 |

所有工具都接受可选的 `path` 指定仓库目录，默认取会话工作目录，相对值按会话目录解析。

### 状态码

`git_status` 输出 git 自己的两列码 —— 先索引态、后工作区态，所以 `.M` 是未暂存的改动，
`M.` 是已暂存的改动。同时也会把词形（`index` / `worktree` 字段）返回给偏好的调用方。

## 安全边界

**绝不经过 shell。** 每次调用都走 `ctx.subprocess.spawn` 的 `argv` 数组。Harness 的另一个接缝
`ctx.shell` 收的是**一整行命令字符串**，用它就等于把每个参数重新交给 shell 解析 ——
而**不存在**一套同时对 cmd.exe、PowerShell 和 POSIX sh 正确的转义（cmd.exe 在双引号内部
依然展开 `%VAR%`）。所以参数干脆不进 shell。含 `"`、`` ` ``、`$(...)`、`%PATH%`、换行、
中文的提交信息会**逐字节原样**存入仓库。

**输出被钉死。** 以下配置在每次调用时强制覆盖（紧跟在 `git` 之后），因为每一项都会改变本插件
所解析的字节：

```
color.ui=false              core.pager=cat
core.quotepath=false        status.relativePaths=false
log.showSignature=false     log.date=default
diff.noprefix=false         diff.mnemonicPrefix=false
diff.external=              advice.detachedHead=false
```

**行为类**配置则**刻意不覆盖**：`user.name`、`user.email`、`core.autocrlf`、hooks、
`core.sshCommand` 是用户的意图，不是噪声。子进程环境额外注入 `GIT_TERMINAL_PROMPT=0`，
让需要凭据的操作**立即失败**而不是卡在一个没人能回答的提示上；以及 `GIT_OPTIONAL_LOCKS=0`，
让读操作不会因为别的窗口占着 `index.lock` 而失败。

**写操作需审批。** `git_commit`，以及 `git_branch` / `git_stash` 的写入动作，都会在
执行前调用 `ctx.approval.request()`。**如果 profile 没有装审批服务，写操作会被拒绝而不是放行**
—— 「静默无保护的 `git commit`」正是本插件要消除的东西。只有在你明确接受这一点时，
才把 `requireApprovalForWrites` 设为 `false`。

**路径先校验。** 绝对路径、`..` 穿越、UNC 路径、驱动器相对形式（`C:foo`）、
NTFS 备用数据流、Windows 保留设备名、控制字符，都在**任何进程启动之前**被拒绝。
git 自己也会拦大部分，但先校验能给出精确消息，并让明显敌意的输入连进程都不进。

**刻意不提供：** `push`、`fetch`、`pull`、`reset`、`clean`、`rebase`、`remote`、config 写入。
在 `bash` 里这些至少还躺在一行人类能读的命令里；做成工具就变成「一次调用摧毁工作区、
只靠一个提示框把关」。fetch 与 push 还牵涉凭据与主机密钥处理，值得单独设计，而不是在这里加个复选框。

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `30000` | 单次调用超时 |
| `maxDiffLines` | `500` | 默认补丁行数上限（钳制在 10–5000） |
| `maxLogEntries` | `50` | `git_log` 默认条数（钳制在 1–500） |
| `requireApprovalForWrites` | `true` | 写操作是否需要审批 |

patch 条目是**整键替换**而非深合并，所以要把想保留的键写全：

```yaml
- insert:
    - id: tool-git
      name: dsh-zcode-git
      config:
        timeoutMs: 60000
        requireApprovalForWrites: true
```

## 开发

```bash
npm test          # node --test
```

**95 个测试**，除 harness 的 peer 包外零依赖，分六层：

- `test/parse.test.js` —— 纯解析器，喂录制的 git 输出
- `test/validate.test.js` —— 路径、提交信息、分支名、revision 校验
- `test/exec.test.js` —— spawn spec，喂记录用的假实现
- `test/tools.test.js` —— 工具行为，喂假 subprocess 服务
- `test/e2e.test.js` —— **真实 git 二进制 + 真实临时仓库**
- `test/schema.test.js` —— 与 harness、provider 的 schema 兼容性

## 给后来写 DSH 工具插件的人

本插件里有四处设计，是因为「显而易见的做法」会失败，**而且都不是在出错的地方报错**。

**① `ctx.tools.register()` 不编译任何东西。** 它只校验 `output.schema`，然后原样存下定义。
`parameters` 的作者 DSL **不会**被转换 —— 所以直接注册原始定义对象，等于把一个没有顶层 `type`
的裸属性 map 送给模型 provider，**整个请求被拒**。必须包一层：
`ctx.tools.register(defineTool(definition))`。而且 provider 只报**字母序第一个**工具的名字，
于是错误指向一个本身没问题的工具。

**② `parameters` 与 `output.schema` 用的是两套 DSL。** `parameters` 是扁平属性 map
（`{ path: { type: "string" } }`）；`output.schema` 是裸 JSON Schema
（`{ type: "object", properties: { ... } }`）。把后者交给 `parameters` 会抛
`parameters.type must be a value schema object`；把前者交给 `output.schema` 会抛
`schema.type must be string/…`。

**③ schema 关键字对版本敏感。** property 内的 `required: true` 在 dsh-tools `0.1.5-rc.2`
上被接受、在 `0.1.6-alpha.2` 上被拒绝（`UNSUPPORTED_SCHEMA`）；顶层 `required: [...]` 数组
两边都拒绝。工具 schema 里出现 `enum` 会让某个 provider 拒绝整个 function schema，报
`must be a JSON Schema of 'type: "object"', got 'type: null'`。所以本插件一个都不用，
而是在代码里强制同样的约束 —— 顺带得到了更好的错误消息：
`unsupported action "x"; expected one of list, create, switch, delete`。

**④ 返回值必须与 schema 严格一致。** 在 schema 声明为 `string` 的位置放 `null`，
会让这一轮以 `INVALID_TOOL_OUTPUT` **失败**，而**此时 git 已经执行成功了**。
没有值就**省略字段**，不要送 `null`。

**⑤ 渲染器在工作已完成之后运行。** 渲染器读了 `execute` 从未返回的字段，会在 harness 内部抛错，
把一次本来成功的调用变成失败的一轮。`test/tools.test.js` 之所以要拿每个工具的输出驱动它自己的
渲染器，就是为这个。

## 许可

MIT
