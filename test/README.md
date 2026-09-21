# Tests

English | [中文](README.zh.md)

One entry point:

```bash
node test/run.mjs
```

It runs every `*.test.js` in this directory, prints both the raw `# tests N`
counters (which `tools/verify-doc-numbers.mjs` reads) and a summary line, and
exits non-zero on any failure. The list of suites is derived by reading the
directory rather than written down — a suite that exists but is never run would
otherwise be skipped everywhere, silently.

## The layers, and what only each one catches

| File | Layer | The failure only this layer sees |
| --- | --- | --- |
| `parse.test.js` | pure parsers | a path containing a space split into two entries |
| `validate.test.js` | pure validation | `..\..\x` slipping past a `/`-only traversal check |
| `exec.test.js` | spawn spec | the argv array quietly becoming a command string again |
| `tools.test.js` | tool behaviour | a renderer reading a field `execute` never returned |
| `schema.test.js` | schemas | a keyword one harness version rejects |
| `e2e.test.js` | real git | a wrong assumption about a git format |

## Why the end-to-end layer is separate

`test/e2e.test.js` creates real repositories under the system temp directory,
runs the real `git` binary, and removes them afterwards. It is slower than the
rest, and it earns that cost: the `%1f` / `%x1f` escape-grammar mistake in
`git branch --format` is invisible to unit tests written against the same wrong
assumption, and it fails silently in production — git emits the literal text, no
field ever splits, and every branch is filtered out with no error at all.

It needs `git` on `PATH`. Where git is absent those cases fail rather than skip,
because a silently skipped end-to-end layer is worse than not having one.
