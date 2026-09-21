# Changelog

English | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-21

First release.

### Added

- Six tools — `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`
  and `git_stash` — each returning structured data rather than scraped text.
- 10 pinned `git -c` settings so the parsed output cannot be reshaped by the
  user's `color.ui`, `core.pager`, `core.quotepath`, `status.relativePaths`,
  `log.showSignature`, `log.date`, `diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.external` or `advice.detachedHead`.
- Approval gating for `git_commit` and for the mutating actions of
  `git_branch` and `git_stash`. With no approval service mounted the mutation
  is refused rather than allowed.
- Path validation that rejects absolute paths, `..` traversal, UNC paths,
  drive-relative forms, NTFS alternate data streams, reserved Windows device
  names and control characters before any process starts.
- Byte-exact commit messages: an argv array goes to `ctx.subprocess.spawn`, so
  `"`, backticks, `$(...)`, `%PATH%`, newlines and CJK text reach git unmangled.
- Six test layers totalling 95 cases, including end-to-end runs against a real
  git binary and the schema checks that guard both harness versions.

### Notes

- Chinese and English documentation are paired; `tools/verify-translation-pairing.mjs`
  is the guard that keeps them that way.
- Deliberately absent: `push`, `fetch`, `pull`, `reset`, `clean`, `rebase`,
  `remote`, and config writes.

[Unreleased]: https://github.com/BOWLUNA/dsh-tool-git/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BOWLUNA/dsh-tool-git/releases/tag/v0.1.0
