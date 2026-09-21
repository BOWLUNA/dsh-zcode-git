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

## Known gaps

- **No large-repository measurements.** `git_status` on a repository with
  thousands of changed files, and the spill path for a diff larger than the
  in-memory ceiling, are covered by unit-level assertions only
  (`clampInteger`, `truncateLines`) — never at real scale.
- **No concurrency measurements.** Tools declare `isConcurrencySafe`, but the
  declaration has not been exercised under parallel calls.
- **No process-reclamation measurement.** A timeout is expressed as an abort;
  that the spawned `git` is actually reaped afterwards has not been verified
  under load.
