# 更新日志

[English](CHANGELOG.md) | 中文

本项目的重要变更记录在此文件中。格式遵循
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [0.1.0] — 2026-09-21

首次发布。

### 新增

- 六个工具 —— `git_status`、`git_diff`、`git_log`、`git_branch`、`git_commit`
  与 `git_stash` —— 全部返回结构化数据，而不是去刮人读文本。
- 每次调用钉死 10 项 `git -c` 配置，使解析结果不受用户的 `color.ui`、
  `core.pager`、`core.quotepath`、`status.relativePaths`、`log.showSignature`、
  `log.date`、`diff.noprefix`、`diff.mnemonicPrefix`、`diff.external` 与
  `advice.detachedHead` 影响。
- `git_commit` 以及 `git_branch`、`git_stash` 的写入动作走审批；没有装审批服务时
  **拒绝执行**而不是放行。
- 路径校验在任何进程启动之前拒绝：绝对路径、`..` 穿越、UNC 路径、驱动器相对形式、
  NTFS 备用数据流、Windows 保留设备名与控制字符。
- 提交信息逐字节精确：交给 `ctx.subprocess.spawn` 的是 argv 数组，因此 `"`、反引号、
  `$(...)`、`%PATH%`、换行与中文都能原样送到 git。
- 六层测试共 95 个用例，包含对真实 git 二进制的端到端运行，以及守护两个 harness
  版本的 schema 检查。

### 说明

- 中英文档成对维护，由 `tools/verify-translation-pairing.mjs` 看守这一约定。
- 刻意不提供：`push`、`fetch`、`pull`、`reset`、`clean`、`rebase`、`remote`
  与 config 写入。

[未发布]: https://github.com/BOWLUNA/dsh-tool-git/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BOWLUNA/dsh-tool-git/releases/tag/v0.1.0
