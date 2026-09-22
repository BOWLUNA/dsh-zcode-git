# dsh-zcode-git

[English](README.md) | 中文

[![test](https://github.com/BOWLUNA/dsh-zcode-git/actions/workflows/test.yml/badge.svg)](https://github.com/BOWLUNA/dsh-zcode-git/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-6b7a3f.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.5--rc.2%20%7C%200.1.6--alpha.x-4a443c.svg)](#环境要求)
[![node](https://img.shields.io/badge/node-%E2%89%A520-4a443c.svg)](#环境要求)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 智能体用的**六个结构化 Git 工具**：
status、diff、log、branch、commit、stash —— 输出被钉死、参数不经过任何 shell、
每一次写入都走 harness 的审批服务。

DSH 本身没有任何 git 工具，模型只能通过 `bash` 手搓命令。这个插件就是来替掉那条路的。

```bash
dsh plugin --profile web add dsh-zcode-git
```

![一条提交信息，两条路 —— shell 命令行与 argv 数组之间被实测出来的差异](assets/how-it-works.svg)

## 与 ZCode 的关系

[ZCode](https://github.com/zai-org/ZCode) 是这个插件做法的来源，而且它的 git 层比大多数实现都扎实。
下表刻意写成**可核对**的：每条 ZCode 的主张都指到文件与行号，每条「多了什么」都指到一条能跑的命令，
**而本插件还没追上的地方，那一行会直接写「暂未超过」，不会略去**。

| ZCode 有什么 | 本插件取了什么 | 本插件多了什么（**优于**在哪） | 证据 |
| --- | --- | --- | --- |
| `workflow-git-world-read.ts:12`（小节标题）与 `:14` —— 「只读是**构造**出来的，不是检查出来的」：只能构造出五个只读子命令，且没有任何一条路径能拼出 shell 字符串 | 同一个前提：每次 git 调用走 `ctx.subprocess.spawn` 的 argv 数组，任何 shell 都看不到参数 | **写操作那一半，并且关在审批后面。** ZCode 的 `git.*` 按构造没有写路径；本插件增加了 commit / stash / branch 三类写操作，且 `ctx.approval` 是 **fail-closed** —— 没挂审批服务时**拒绝执行**而不是放行 | `node tools/verify-comparison.mjs` → row 1 · `test/exec.test.js` · `node tools/measure.mjs --only argv` |
| `workflow-git-world-read.ts:80` —— `GIT_REF_PATTERN`，以及 `:72` —— 「首字符不许是 `-` 是这条规则里唯一**安全相关**的部分」 | 同一条规则：`validateRevision` 拒绝以 `-` 开头的 revision | 扩到分支名、提交信息与路径 —— 而且这一行把「**为什么只有 revision 需要这条短横线规则**」写清楚了：所有用户提供的名字都排在 `--` 之后，所以 `git branch -- -b` 是名字而不是选项。ZCode 在这一点上也是**按构造**达到同样的效果 | `node tools/verify-comparison.mjs` → row 2（含 `--` 位置的断言）· `test/validate.test.js` |
| `workflow-git-world-read.ts:22` —— `-z` 的契约，记着 `core.quotePath` 与「含换行的文件名」；`:98` —— `GIT_STATUS_ARGV` 里的那个 `-z`；`:26` —— 「我们自己的 `git log` 也已经用 `%x00` 分隔字段」 | 同样的 `-z`，扩到 `status` 与 `stash list` | 字段分隔符**不同，而且我这边是更弱的选择**：本插件用 `%x1f`，ZCode 用 `%x00`。NUL 在 git 对象里根本不可能出现，所以**这一行本插件暂未超过 ZCode** | `node tools/verify-comparison.mjs` → row 3 |
| `git-snapshot.ts:127` —— `execFile(GIT_COMMAND, args, {cwd, maxBuffer, timeout})`：走了 argv，但**不钉 `-c`、也不覆盖 `env`** | 同样走 argv 数组 | **钉死十项 `git -c` 覆盖**（`color.ui`、`core.pager`、`core.quotepath`、`diff.external`、`status.relativePaths`、`log.showSignature`、`log.date`、`diff.noprefix`、`diff.mnemonicPrefix`、`advice.detachedHead`），用户的配置改不了模型读到的字节。ZCode 反而把 `git -c` 列进了它 **bash 通道**的 `GIT_GLOBAL_DANGEROUS_FLAGS` —— 在 shell 里那样做是对的，因为那个 flag 来自用户；而这里它由我们构造，且从不经过 shell | `node tools/verify-comparison.mjs` → row 4（逐名断言十项都真的到了 git） |
| `workflow-git-world-read.ts:28` —— **单一路径基准**：线上一律仓库根相对，再用 `rev-parse --show-prefix` 剥前缀；`:36` —— 「工作区就是仓库根时三者恰好相同，所以它会一直不被发现」 | —— | **暂未超过。** 本插件这一层完全没做：会话 `cwd` 在子目录时交出仓库根相对路径，把那些路径喂回去会得到 `ok: true, files: [], message: ""` —— 静默地什么都没有。已建缺陷档 | `node tools/verify-comparison.mjs` → row 5（断言该缺口**仍然复现** —— **这条检查会在它被修好的那天变红**，这正是目的）· `node tools/_probe-pathbase.mjs` |
| `git-snapshot.ts:168` —— `git status` 按 **2k 字符**截断（而不是按文件条目数），以保持 provider-visible prompt 形状稳定 | 同一个关切：输出要有边界 | **按条目数与行数分别限，并把截断如实交出去而不是静默截断**：`maxDiffLines` / `maxLogEntries` / `clampInteger`，接缝溢出时报 `truncated: true` 并给出溢出路径（实测：21.6 MiB 的补丁到模型手上是 264 KB） | `node tools/verify-comparison.mjs` → row 6 · `node tools/measure.mjs --only spill` · `test/validate.test.js` |

### 怎么自己复核

上面每一行都能归到一条命令上。表里没有任何东西需要「信」：

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-git && cd dsh-zcode-git
npm install                       # 链上 harness 的 peer 包；本插件没有运行时依赖
node tools/verify-comparison.mjs  # 逐行核对上面的表 —— 某行说过头就以非零退出
node test/run.mjs                 # 95 项检查
node tools/measure.mjs            # 图里那些数字背后的一次实测，约 18 秒
```

第 5 行报的是 `GAP REPRODUCES` 而不是 `PASS`：它是缺陷、不是「优于」，而这条检查断言的是
**这个缺陷仍然存在** —— 这样它被修好之后，README 就没法悄悄继续那么写。

## 本插件针对 `bash` 做了什么

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
