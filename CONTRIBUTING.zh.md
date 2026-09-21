# 参与贡献

[English](CONTRIBUTING.md) | 中文

感谢关注。这是一个用途很窄的小插件，最有用的一类贡献通常是一个「这样跑是错的」的复现，
或者一条把没人想到过的情况钉死的测试。

## 开发环境

除了 Node 不需要装任何东西 —— 本插件没有运行时依赖，唯一的 peer 由 harness 提供。

```sh
npm test
```

测试用 `node --test` 跑，需要 `PATH` 上有一个真实的 `git`；端到端那层会在系统临时目录下
建用完即弃的仓库，并在结束后删掉。

## 三道守卫

CI 三道都跑，各自能抓住另两道抓不到的一类错误。推送前请先本地跑一遍 —— 本仓库曾经因为
「改了数字却没重录配对哈希」而让四条 CI 矩阵全部变红。

```sh
node tools/verify-translation-pairing.mjs           # 双语配对
node tools/verify-version-consistency.mjs           # 声明的 dsh 范围 vs 实测
node tools/verify-doc-numbers.mjs                   # 文档里的数字 vs 实际运行结果
```

- 改动了任何**计数**（测试数、工具数、钉死配置项数），跑
  `verify-doc-numbers.mjs`，并更新它点名的每一份文档。
- 改动了**任一语言的文件**，跑
  `verify-translation-pairing.mjs --write` 重新记录配对。
- 改动了**兼容的 harness 范围**，跑
  `verify-version-consistency.mjs` —— 它检查 `engines.dsh` 是否仍覆盖 CI 矩阵安装的每个版本。

## 文档配对

每一份面向用户的文档都存在两份，**权威相同**：

| 英文 | 中文 | 配对记录 |
| --- | --- | --- |
| `README.md` | `README.zh.md` | `README.i18n.yaml` |
| `CHANGELOG.md` | `CHANGELOG.zh.md` | `CHANGELOG.i18n.yaml` |
| `CONTRIBUTING.md` | `CONTRIBUTING.zh.md` | `CONTRIBUTING.i18n.yaml` |
| `SECURITY.md` | `SECURITY.zh.md` | `SECURITY.i18n.yaml` |

两份都不是对方的翻译，而是同一内容的两版呈现。每个文件开头都有一行语言切换，
每对文件旁边的 `.i18n.yaml` 记录着「上次确认一致」时两侧的 git blob 哈希。

## 不变量

改动 `src/` 下任何东西，或 `index.js` 里的工具定义之前，请先读
[`AGENTS.md`](AGENTS.md)。它的「What must not break」不是风格建议 ——
每一条都是在真实 harness 里被观察到过的失败，其中几条还是静默失败，
而且每条都点名了看守它的测试。

## 提交与 PR 约定

- 提交信息用规范式：`type(scope): subject`（`feat`、`fix`、`docs`、`test`、
  `refactor`、`chore`）。
- 改变行为的 PR 请说明：读者此后能做到什么以前做不到的事，以及你如何验证的。
- 请注明你在哪个 harness 版本、哪个平台上测过。`0.1.5-rc.2` 与 `0.1.6-alpha.2`
  之间、Windows 与 Linux 之间行为都有差异，没测的轴值得讲出来，而不是假定它没问题。
- 只在截图真的携带文字表达不了的信息时才加。本插件自身没有界面，这种情况很少。

## 报告缺陷

开 issue 时请给出 harness 版本、平台、确切的工具调用，以及发生了什么。如果工具是**返回了
错误结果**而不是直接失败，那么把渲染出来的文本，与你手跑同样命令时 `git` 的说法并列，
是最有用的一组对照。安全类问题请改走 [`SECURITY.md`](SECURITY.md)。
