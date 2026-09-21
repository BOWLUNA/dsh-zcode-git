# Security Policy

English | [中文](SECURITY.zh.md)

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/BOWLUNA/dsh-zcode-git/security/advisories/new).
Please do not open a public issue for a vulnerability.

A useful report contains:

- the affected version (`npm view dsh-zcode-git version`, or the commit you tested),
- a minimal reproduction — the tool call, the repository state, and what happened,
- the impact you believe it has.

This is a small project maintained without a security team. Expect an
acknowledgement within a few days rather than an hour, and please state plainly
if you intend to disclose publicly so the timeline can be agreed.

## Threat model

A dsh profile plugin is **statically installed, unsandboxed trusted code**: it
runs in the harness process with the harness's privileges and can spawn
processes and read files at will. That is the platform's design, not a property
of this plugin, and it means the interesting question is not "can this plugin
do damage" — it can, like any plugin — but **which damage it refuses to do on
the model's behalf**.

### What this plugin defends against

- **Shell interpretation of model-supplied text.** Every git invocation is an
  argv array handed to `ctx.subprocess.spawn`. No command line is ever
  constructed, so a commit message or path containing `"`, backticks, `$(...)`,
  `%PATH%`, `&`, `;`, `|` or a newline cannot be reinterpreted. This matters
  most on Windows, where cmd.exe expands `%VAR%` even inside double quotes and
  there is no single escaping rule that covers cmd.exe, PowerShell and POSIX sh.
- **Path escape.** Absolute paths, `..` traversal (in either separator style),
  UNC paths, drive-relative forms such as `C:foo`, NTFS alternate data streams,
  reserved Windows device names and control characters are rejected before a
  process starts. git would refuse most of these too; validating first keeps
  obviously hostile input away from a process entirely and returns a precise
  message instead of exit 128.
- **Unrequested mutation.** `git_commit`, `git_branch` and `git_stash` route
  their mutating actions through `ctx.approval.request()`. With no approval
  service mounted the mutation is **refused**, not allowed: a silently
  unguarded `git commit` is the specific outcome this plugin exists to prevent.
- **Output-shape manipulation.** Output is pinned with 10 `git -c` overrides,
  so a repository-local or global setting (`color.ui=always`,
  `diff.external=<program>`, `core.pager=<program>`, `status.relativePaths`)
  cannot inject escape sequences into parsed output or redirect it through a
  binary of the repository's choosing.
- **Silent destruction.** `push`, `fetch`, `pull`, `reset`, `clean`, `rebase`,
  `remote` and config writes are not provided at all.

### What it does not defend against

- **A malicious plugin loaded alongside it.** Profile plugins share one process
  and one context. Install plugins you trust.
- **A hostile `git` earlier on `PATH`.** The binary is resolved by the
  subprocess seam through the normal PATH walk.
- **A repository containing hooks, filters or attributes that execute code.**
  `core.hooksPath`, `filter.*.clean`, `diff.external` and `.gitattributes`
  filters run programs that the repository supplies. The pinned configuration
  neutralises `diff.external` for this plugin's own invocations, but a
  repository can still cause code execution through other git features. Treat
  cloning an untrusted repository the same way you would outside this plugin.
- **Filesystem reach.** An explicit absolute `path` argument is honoured, as it
  is for `bash`. The boundary for what a session may read or write is the
  harness sandbox and approval policy, not this tool.
- **Secrets in a repository.** Reading a file with a credential in it and
  echoing it into the conversation is a model behaviour this plugin does not
  police.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.0` | ✅ |
| anything older | ❌ |

Only the latest published version is supported. The plugin is versioned
independently of the harness and declares its compatible range in
`package.json` (`engines.dsh`); `node tools/verify-version-consistency.mjs`
checks that the declared range still contains every harness version the test
matrix exercises.
