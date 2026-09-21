# Troubleshooting

English | [中文](TROUBLESHOOTING.zh.md)

Symptoms, causes, and the fix that actually works. Every entry is something that
happened, not something that might happen.

## The tools do not appear in a session

The plugin registers on a profile, and profile bundles are read while the profile
is composed at boot. Restart the harness after installing:

```bash
dsh --profile web --dump-config | grep -c 'id: tool-git'    # expect 1
```

If that count is 1 and the tools are still missing, the plugin loaded but its
registration failed. Look in the harness log for an error naming a tool.

## `tool "git_status" is already registered`

Another plugin in the same profile registers the same tool names. This is a hard
boot failure for the **whole profile**, not a conflict scoped to one tool.

Two properties make it hard to diagnose:

- `--dump-config` cannot see it. It composes configuration and never calls
  `apply()`, so it reports a clean tree at the same moment boot is failing.
- A plugin can register successfully and still be unusable.
  `ctx.tools.register()` validates only `output.schema`, so a definition whose
  `parameters` are malformed still takes the name, and only fails later — in the
  model provider, where the error names the tool rather than the cause.

Remove whichever of the two you did not intend to use. See item 4 in
[`AGENTS.md`](../AGENTS.md).

## `git` is not found

The binary is resolved by the subprocess seam through a normal PATH walk. Either
git is not installed, or the harness process runs with a PATH that excludes it.

```bash
git --version
```

## A mutation was refused

`git_commit`, and the mutating actions of `git_branch` and `git_stash`, require an
approval decision. A refusal has two distinct shapes:

- **No approval service is mounted.** This is the fail-closed default.
  Mount `@deepseek-ai/dsh-user-approval`, or set `requireApprovalForWrites: false`
  to accept unguarded writes knowingly.
- **An approval service exists and declined.** The message names the outcome.

## The diff looks truncated

There is a line ceiling (`maxLines`, default 500) and an 8 MiB per-stream ceiling
in the subprocess request. Truncation is reported rather than silent, and when the
seam spilled the stream to disk the result carries the path to the full output.

## Paths came back with octal escapes

They should not: `core.quotepath=false` and the `-z` record formats both prevent
it. Seeing `"\346\226\207"` means either an unsupported git version is in use, or
something is constructing its own git invocation instead of going through
`src/exec.js`.
