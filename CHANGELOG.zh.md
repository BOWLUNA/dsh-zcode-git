# 更新日志

[English](CHANGELOG.md) | 中文

本项目的重要变更记录在此文件中。格式遵循
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

### 变更

- `tools/boot-check.sh` 改为 `tools/boot-check.mjs`。bash 版只能在 Linux 上跑 ——
  Git Bash 会改写传给原生 node 进程的 POSIX 路径 —— 所以永远覆盖不到 Windows。
  Node 版在除 Node 20 之外的每一条 CI 腿上都会跑。
- 断言 C 现在要求「端口在两秒后仍在应答、且进程仍然存活」。实测：插件入口抛错时，
  harness 会先绑端口、服务约 200 毫秒、然后才死；旧版「连上一次就算过」会把一个
  坏掉的插件报成启动成功。
- 守卫按 `--dsh-bin`、`$DSH_INSTALL`、`<repo>/node_modules`、`PATH` 的顺序定位 harness，
  全都找不到时以退出码 2（而不是 1）结束 —— 环境缺件不是插件缺陷。
- `.gitignore` 里 `node_modules` 去掉了尾斜杠：带斜杠只匹配目录，于是同名符号链接
  不会被忽略。

## [1.0.1] — 2026-09-21

只动 CI、打包与发布管道。运行时行为未变，工具签名也没有移动，所以对已经在用
1.0.0 的人来说这次升级是无感的。

### 新增

- `tools/boot-check.sh` —— 把插件装进一次性 harness home，并要求一次真实的
  `--port` 启动之后**端口确实应答**、且 stderr 为空。一个根本起不来的插件仍能让测试套件、
  `--dump-config` 与打包自检全部通过 —— 因为补丁行的包名是在启动时对着 profile 解析的，
  而比真启动更便宜的手段都不会去 apply 插件。断言落在**套接字**上而不是「打印出的监听 URL」上：
  `0.1.5-rc.2` 启动成功却什么都不打印，`0.1.6-alpha.2` 才打印横幅，而这两条线都在支持范围内。
  它必须跑在 `npm install --no-save @deepseek-ai/dsh` 与
  `node tools/link-harness-peers.mjs` 之后，这两步才让插件自身的 peer 导入可解析；
  脚本会自己发现 harness，而不是假设它在 `PATH` 上。
- CI 里在矩阵的 Linux 腿跑上述脚本的一步。

### 修复

- release 工作流现在会创建 GitHub Release。它原先带的是
  `permissions: contents: read` 且没有这一步，于是推 tag 之后仓库的 Releases 面板
  停在上一个版本：tag 与提交都动了，首页却像什么都没发生。
- Release 正文取自本文件对应版本的章节，而不是另写一份；并且在 `npm publish`
  没有成功时明确写出来。

## [1.0.0] — 2026-09-21

首个公开发布版。下面的 0.1.0 是开发期序列，1.0.0 才是发布到插件市场的第一个版本。

### 包含

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

### 兼容性

- 在 dsh `0.1.5-rc.2`（稳定线）与 `0.1.6-alpha.2`（预览线）上开发并验证过，
  平台覆盖 Windows 与 Linux。
- 用到的宿主 API：`ctx.tools`（`register`、`defineTool`）、`ctx.subprocess`（`spawn`）、
  `ctx.approval`（`request`）与 `ctx.effect`，以及声明式的 `inject: ['tools']`。
- 声明范围：`>=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0`。那两个显式的 `||`
  分支是必须的：node-semver 只在该版本自己的 `major.minor.patch` 元组上有比较符、
  且该比较符自带预发布标签时才放行预发布版，所以单写 `>=0.1.5-rc.2 <0.2.0-0`
  会静默排除 `0.1.6-alpha.2`。

## [0.1.0] — 2026-09-21

开发期序列。

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

[未发布]: https://github.com/BOWLUNA/dsh-zcode-git/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BOWLUNA/dsh-zcode-git/releases/tag/v1.0.0
[0.1.0]: https://github.com/BOWLUNA/dsh-zcode-git/releases/tag/v0.1.0
