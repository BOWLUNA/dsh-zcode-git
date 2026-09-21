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

## 已知缺口

- **没有大规模仓库的测量。** 数千改动文件下的 `git_status`、以及超出内存上限的 diff 的
  spill 路径，目前**只有单元级断言**（`clampInteger`、`truncateLines`），**从未在真实规模下跑过**。
- **没有并发测量。** 工具声明了 `isConcurrencySafe`，但那个声明从未在并行调用下被验证过。
- **没有进程回收测量。** 超时被表达为 abort；被 spawn 出来的 `git` 之后是否真被回收，
  没有在负载下验证过。
