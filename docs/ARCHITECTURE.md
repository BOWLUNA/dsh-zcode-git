# Architecture

English | [中文](ARCHITECTURE.zh.md)

Why this plugin is built the way it is. The shorter version is in the
[README](../README.md); this file records the reasoning and the constraints,
including the ones that cost a debugging session.

## The one decision everything else follows from

A harness agent can already run git, through `bash`. This plugin exists because
that route has three properties that cannot be fixed from inside a shell
command:

1. **Output shape belongs to the user's configuration, not to the tool.**
   `git status`, `git diff` and `git log` are rendered for a human reading a
   terminal. Their exact bytes depend on `color.ui`, `core.pager`,
   `core.quotepath`, `status.relativePaths`, `diff.external`,
   `diff.noprefix`, `diff.mnemonicPrefix`, `log.showSignature` and `log.date`.
   A parser written against the output on the author's machine breaks on a
   machine that has any of those set differently, and it breaks *quietly* —
   the tool returns a plausible wrong answer rather than an error.
2. **The argument has to survive a shell.** `git commit -m "<message>"` means
   the message goes through cmd.exe, PowerShell or POSIX sh depending on the
   host. Their escaping rules disagree, and none of them preserves `%PATH%`,
   `$(...)`, a backtick or a newline by accident. On Windows this is not a
   theoretical concern: cmd.exe expands `%VAR%` even inside double quotes.
3. **Reading and destroying are the same tool.** In `bash`, `git status` and
   `git push --force` differ only in the text typed. The harness's approval
   layer sees one tool called `bash` and cannot tell them apart.

Everything below is a consequence of addressing those three.

## No shell, ever

Every invocation is built as an **argv array** and handed to
`ctx.subprocess.spawn`. A shell never parses an argument, so there is nothing
to escape.

The harness offers two process seams, and the choice between them is the whole
argument:

| Seam | Request shape | Escaping required |
| --- | --- | --- |
| `ctx.shell` | one command line (string) | yes — and no single rule works across cmd.exe, PowerShell and POSIX sh |
| `ctx.subprocess` | an argv array | none |

`ctx.shell` is the right seam for a tool whose purpose is to run shell
commands. For a tool whose purpose is to run *one known program with known
arguments*, it adds a parsing problem without adding a capability. So
`src/exec.js` uses `ctx.subprocess`.

The consequence worth stating: a commit message containing `"`, `` ` ``,
`$(rm -rf /)`, `%PATH%`, a newline, or CJK text reaches git byte-for-byte, and
the end-to-end suite proves it by reading the message back out of the
repository rather than by asserting that the call succeeded.

## Output is pinned, not parsed leniently

Ten settings are forced on every invocation with `-c key=value`, immediately
after `git` so they outrank every configuration file:

| Setting | What it would otherwise do |
| --- | --- |
| `color.ui=false` | embed ANSI escapes in captured output |
| `core.pager=cat` | launch a pager whose child holds the pipe open |
| `core.quotepath=false` | render `文档.txt` as `"\346\226\207..."` |
| `status.relativePaths=false` | make status paths relative to the process cwd, not the repository root |
| `log.showSignature=false` | inject signature blocks into log output |
| `log.date=default` | follow the user's date format |
| `diff.noprefix=false` | drop the `a/`…`b/` prefixes |
| `diff.mnemonicPrefix=false` | replace those prefixes with `i/`/`w/`/`c/` |
| `diff.external=` | hand the diff to a program of the repository's choosing |
| `advice.detachedHead=false` | add a hint paragraph to stderr on detached HEAD |

Behavioural settings are deliberately **not** pinned. `user.name`,
`user.email`, `core.autocrlf`, `core.sshCommand` and hook configuration are the
user's intent, not noise — overriding them would make the tool commit under the
wrong identity or ignore the repository's line-ending policy.

Where git offers a machine format, it is used and the human format is never
parsed: `--porcelain=v2 -z` for status, `--numstat -z` for diffs, a
NUL-and-`%x1f` record format for log, `for-each-ref` field syntax for branches.

## Module layout

```
index.js              tool definitions: schema, execute, render, presentationMeta
cordis.patch.yml      the profile row this package inserts
src/exec.js           spawn spec construction, pinned config and env, workdir resolution
src/parse.js          pure parsers for git's machine formats
src/validate.js       pure input validation
src/render.js         pure renderers, model-facing text
test/                 six layers, see test/README.md
tools/                the three guards and a peer-linking helper
```

The split is along one line: `parse.js`, `validate.js` and `render.js` are
**pure functions** with no I/O and no harness dependency, which is why they can
be tested exhaustively without a repository. `exec.js` is the only module that
touches the process seam, and `index.js` is the only one that touches the
harness.

## Approval

`git_commit`, and the mutating actions of `git_branch` and `git_stash`, call
`ctx.approval.request()` before running anything. The decision must come back
`allowed-once`; anything else aborts.

With **no approval service mounted, the mutation is refused**, not allowed. A
silently unguarded `git commit` is precisely the outcome this plugin exists to
prevent, so failing closed is the only consistent default. A profile that
genuinely has no approval layer can opt out with
`requireApprovalForWrites: false`, which is a deliberate decision rather than
an accident.

## What is deliberately absent

`push`, `fetch`, `pull`, `reset`, `clean`, `rebase`, `remote`, and configuration
writes.

In `bash` these are at least visible in a command line a human can read before
pressing enter. As a tool they become a one-call destroyer guarded only by a
prompt, and the failure mode of a wrong `reset --hard` is unrecoverable work.
Fetch and push additionally need credential and host-key handling that deserves
its own design instead of a checkbox here.

This is a scope decision, not a technical limit. `ctx.subprocess` could run any
of them.

## Compatibility

The plugin declares `engines.dsh: ">=0.1.5-rc.2 <0.2.0-0"` and is tested
against `0.1.5-rc.2` (stable) and `0.1.6-alpha.2` (preview) on Linux and
Windows. The two harness versions differ in ways that matter to a tool plugin:

- `required: true` inside a property is accepted by `0.1.5-rc.2` and rejected
  by `0.1.6-alpha.2`.
- A top-level `required: [...]` array is rejected by both.

This plugin therefore declares neither, and enforces the same constraints in
`execute`. See [`AGENTS.md`](../AGENTS.md) for the full list of what must not
break and why.
