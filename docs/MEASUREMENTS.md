# Measurements

English | [中文](MEASUREMENTS.zh.md)

Every claim on this page carries the command that produced it. A number in a
README is a claim like any other, and this repository's rule is that claims are
checked rather than remembered.

## Test suite

```console
$ node test/run.mjs
suites: 6
# tests 95
# pass 95
# fail 0
结果: 95 通过, 0 失败
```

Six layers, split by what each one can catch that the others cannot:

| Layer | File | The failure only this layer sees |
| --- | --- | --- |
| parsers | `test/parse.test.js` | a path containing a space split into two entries |
| validation | `test/validate.test.js` | `..\..\x` slipping past a `/`-only traversal check |
| spawn spec | `test/exec.test.js` | the argv array quietly becoming a command string again |
| tool behaviour | `test/tools.test.js` | a renderer reading a field `execute` never returned |
| schemas | `test/schema.test.js` | a schema keyword one harness version rejects |
| end-to-end | `test/e2e.test.js` | a git format assumption that is simply wrong (see below) |

The last row earned its place: `git branch --format` uses the **for-each-ref**
escape grammar (`%1f`), not `git log`'s `%xXX`. Written the wrong way, git emits
the literal text `%x1f` and no field ever splits, so every branch is filtered
out — silently, with no error. Unit tests written against the same wrong
assumption pass. Only a real git binary catches it.

## Platform results

| Platform | Command | Result |
| --- | --- | --- |
| Windows | `node test/run.mjs` | 95 / 95 pass |
| Linux (WSL) | `node test/run.mjs` | 92 pass, 1 skip, 0 fail |

The skip is `validateRepoRelativePath applies the Windows-only hazards on
Windows` — alternate data streams and reserved device names have no Linux
equivalent, so the case reports itself as skipped rather than passing vacuously.

## Acceptance: the user's configuration cannot reshape the output

The repository under test has `color.ui=always`, `status.relativePaths=true`,
`core.quotepath=true` and an alias configured, then a file with a CJK name and a
file with a space in its name are created:

```console
$ node --test test/e2e.test.js
ok 4 - acceptance 5 — the user's git configuration cannot reshape the output
```

The assertions are that no path contains `../`, no output contains an ANSI escape
(`\u001b[`), and the CJK filename comes back as `café.txt` rather than as octal
escapes.

## Acceptance: the commit message is stored verbatim

The message is written, then **read back out of the repository**:

```console
$ node --test test/e2e.test.js
ok 5 - acceptance 6 — a commit message with shell metacharacters is stored verbatim
ok 6 - acceptance 6 — a message that is only metacharacters still survives
```

The first case uses `%PATH%`, `$(whoami)`, `"`, a backtick, a newline and CJK
text; the second is nothing but metacharacters. Both compare against
`git log -1 --format=%B` rather than against the tool's own echo.

## A real turn, with the model choosing the tool

The task text never names a tool. The model chose three of them, and the
session log is the evidence:

```console
$ node session-trace.mjs --home ~/.dsh --session <id> --summary
会话 …：38 条记录，4 次工具调用
     1 × git_status   1 × git_diff   1 × git_log   1 × git_branch
```

Counters can be made to pass vacuously, so the check runs a negative control —
asserting a tool that does not exist must fail:

```console
$ --expect 'git_status=1'   → exit 0
$ --expect 'git_push=1'     → exit 1   (there is no such tool)
```

## The test lab

Every number below was taken on this project's own harness instance rather than
a shared one, and any of them can be reproduced:

```console
$ export DSH_INSTALL="<harness root>"     # the directory holding node_modules/@deepseek-ai/dsh
$ node tools/boot-check.mjs --port 32070  # a real boot, four assertions
```

| | |
| --- | --- |
| harness | `@deepseek-ai/dsh@0.1.6-alpha.2` |
| node | v22.22.2 |
| port | 32070 (this project's slot) |
| boot check | exit 0 · 4375 ms · A/B/C/D all pass · `C: held for 2000ms` · `D: 0 bytes` |
| `--dump-config` | exit 0 · 568 lines · stderr 0 bytes |

Nothing is hardcoded to a machine path: `DSH_INSTALL` is the only way to point
the scripts at a harness, which is why this section describes an instance rather
than naming one.

## At scale

Three things the gaps list used to say had never been measured. All four below
come from one run of:

```console
$ node tools/measure.mjs --large-files 3000 --concurrency 8 --big-mb 10
```

**What is real, and what is a stand-in.** The plugin's own path is real
(`defineTools` → each tool's `execute` → `runGit`), the `git` binary is real,
and so are the OS processes, the abort ladder, the file system and the clock.
The `ctx.subprocess` service is a **stand-in**: the production implementation is
a cordis service that cannot be constructed outside the harness, so
`tools/measure.mjs` implements the documented seam itself — an argv array,
`cwd`, `env`, `{maxBytes, spill}` per stream, `graceMs` and an abort signal.
Read every number as "the plugin's behaviour, measured", not as "the production
subprocess service, measured".

### Large repository

| | |
| --- | --- |
| changed files | 3000 |
| files `git_status` reported | 3000 |
| wall time | **40 ms** |
| raw git stdout | **377 963 bytes** |
| rendered text | 56 919 bytes |
| stream hit the 8 MiB ceiling | no |
| git subprocesses spawned | 1 |
| argv the tool built | `--porcelain=v2 --branch --untracked-files=all -z` |

The rendered size is the interesting part: 3000 changed paths arrive as 378 KB of
porcelain and leave as 57 KB of structured text, complete. Nothing is truncated
at this size, so the earlier "unit-level only" gap was a real gap — `clampInteger`
does not fire here.

### The spill path

| | |
| --- | --- |
| generated patch | **22 649 443 bytes** (21.6 MiB) |
| `--numstat` | `209716  209716  big.txt` |
| stream ceiling | 8 MiB |
| seam kept | **8 388 608 bytes** — exactly the ceiling |
| seam spilled to disk | **14 260 835 bytes** |
| kept + spilled | 22 649 443 bytes — the whole patch, nothing dropped |
| tool reported `truncated` | **true** |
| patch the tool returned | 269 844 bytes |
| rendered | 270 035 bytes |
| spill path handed to the model | **yes** |
| wall time | 698 ms |

A 21.6 MiB diff against an 8 MiB per-stream ceiling: the seam keeps exactly the
limit and spills the rest, and the two add up to the patch byte for byte. The
tool reports `truncated: true` rather than silently returning a prefix, tells the
model where the complete output is, and what reaches it is 264 KB rather than
21.6 MB.

### Concurrency

`isConcurrencySafe` was a declaration; this exercises it.

| | |
| --- | --- |
| parallel `git_status` calls | 8 |
| serial wall | 197 ms |
| parallel wall | **54 ms** |
| every parallel result byte-identical to serial | **true** |
| distinct result hashes across the 8 | 1 |
| distinct subprocess pids | 16 (8 serial + 8 parallel) |

Each call gets its own `git` process and its own buffers, so the results do not
interleave. The 4× wall-time win is incidental; the point is that the eight
results hash to the same value as the serial baseline.

### Process reclamation

A deadline is expressed as an abort, so the question is whether the `git` child
is actually gone afterwards. Driven through `runGit` (the layer that owns the
deadline — a tool turns a failure into a model-readable shape that drops
`timedOut`):

| | |
| --- | --- |
| `timeoutMs` | 1 |
| `runGit` reported `timedOut` | **true** |
| exit / signal seen by `runGit` | `null` / `SIGTERM` |
| `runGit` returned after | 8 ms |
| child gone after | **8 ms** |
| `reaped` | **true** |

At a 1 ms deadline the child is terminated, `runGit` says so rather than
reporting a bare failure, and the process is observable as gone in the same
millisecond. That is what the seam's `graceMs` ladder is for.

## argv versus a command line

The whole design rests on this contrast, so it is measured rather than asserted.
One hostile commit message — `%PATH%`, `$(echo pwned)`, `` `id` ``, both quote
characters, and a newline — sent two ways:

| | argv array (this plugin) | `bash -c "git commit -m \"…\""` |
| --- | --- | --- |
| bytes sent | 114 | 114 |
| bytes git received | **114** | **144** |
| round-trips byte-for-byte | **yes** | **no** |
| sha256 of what git stored | `1ad1f3379f68c256` | `c22c39104c8c3d2e` |
| sha256 of what was sent | `1ad1f3379f68c256` | — (differs) |

What the shell path stored in the commit message, read back from the repository:

```
subject with %PATH% and pwned and uid=197609(BOWLUNA) gid=197121 groups=197121
```

`$(echo pwned)` became `pwned`, and `` `id` `` became the real output of `id` —
**the local account and group ids were written into a commit message**. That is
the failure this plugin exists to make impossible, and the argv row is why it is
impossible.

## Known gaps

- **Sub-directory path base.** Measured 2026-09-22, and it is a defect rather
  than a gap: with the session `cwd` inside a subdirectory, `git_status` and
  `git_diff` hand back **repository-root-relative** paths while the model's base
  is the working directory. Feeding those paths straight back returns
  `ok: true, files: [], message: ""` — silently nothing. Reproduction and the
  fix plan are in
  `plugins/git/dsh-zcode-git/issues/GIT-4-子目录下路径基准不一致.md`; the
  contrast with the implementation that solved it is in the README's ZCode
  section.
- **The production subprocess service is not measured.** Every number in
  "At scale" runs against a faithful stand-in for `ctx.subprocess`, not against
  `@deepseek-ai/dsh-subprocess-local`. Numbers that depend on the real seam's
  spill file format, job-object semantics or Windows runner are therefore not
  covered.
- **Concurrency is measured at 8, on one machine.** The declaration is exercised
  and the results agree with serial; nothing here says what 64 parallel calls on
  a loaded box would do.
- **No measurement against a repository with a huge history.** The large-repo
  numbers are about working-tree size (3000 changed files), not about `git log`
  over a deep history.
