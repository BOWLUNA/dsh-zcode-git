# AGENTS.md

Instructions for coding agents working in this repository. The human-facing
version is [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What this is

A DeepSeek Harness (dsh) plugin that registers structured Git tools, so an agent
stops driving git through `bash`. One artifact on one mounting plane:

| Artifact | What it is | Where it goes |
| --- | --- | --- |
| this repository | an npm package that also declares `dsh.bundle.patch` | `dsh plugin --profile web add dsh-zcode-git` |

## Commands

```sh
npm test                                       # node --test — 95 tests, six layers
node tools/verify-translation-pairing.mjs      # bilingual pairing (what CI runs)
node tools/verify-version-consistency.mjs      # package engine range vs dsh tested
node tools/verify-doc-numbers.mjs              # documented counts vs the real run

# Against a real harness: ALWAYS a throwaway DSH_HOME, never the one in use.
# 31870-31879 is this project's port range; 3080/3099 are taken by a resident
# WSL harness and are invisible to Windows' netstat.
LAB="$PWD/.lab/dsh-home"
DSH_HOME="$LAB" dsh plugin --profile web add "$PWD"
DSH_HOME="$LAB" dsh --profile web --port 31870 --no-open

# The same boot, asserted instead of eyeballed. Needs the harness install and
# the peer link first, because the plugin imports its peers from its own
# directory — without them this fails for reasons that are not the plugin.
npm install --no-save @deepseek-ai/dsh@0.1.6-alpha.2
node tools/link-harness-peers.mjs
bash tools/boot-check.sh                       # BOOT_HOME / BOOT_PORT / DSH_BIN
```

## What must not break

Each item below is a failure that was actually observed, not a precaution. The
test named in parentheses is what keeps it from coming back.

1. **No shell, ever.** Every git invocation goes through
   `ctx.subprocess.spawn` with an `argv` array. Never build a command string,
   and never route git through `ctx.shell` (whose request *is* a command line).
   There is no escaping routine correct for cmd.exe, PowerShell, and POSIX sh at
   once — cmd.exe expands `%VAR%` even inside double quotes — and the whole
   point of this plugin is that a commit message containing `"`, `` ` ``,
   `$(...)`, `%PATH%` or a newline reaches git byte-for-byte.
   (`test/exec.test.js`, `test/e2e.test.js` acceptance 6)

2. **`defineTool` is not optional.** `ctx.tools.register()` validates only
   `output.schema` and stores the definition *verbatim*; it never compiles
   `parameters`. Registering the raw object sends the authoring DSL — a bare
   property map with no top-level `type` — to the model provider, which rejects
   the entire request with `must be a JSON Schema of 'type: "object"', got
   'type: null'`. It names only the **alphabetically first** tool, so the error
   points at a tool that is not at fault. Always
   `ctx.tools.register(defineTool(definition))`.
   (`test/schema.test.js`)

3. **Verify with a real `--port` boot, not with `--dump-config`.**
   `--dump-config` composes configuration; it does **not** apply plugins. This
   plugin once made the shared profile unbootable (`tool "git_status" is
   already registered`) while `--dump-config` reported a clean tree with
   `exit 0` and empty stderr. A green dump is not evidence that the plugin
   loads. `tools/boot-check.sh` is the assertion form of this rung and the
   Linux legs of `test.yml` run it. (`test/` cannot see it: the suite never
   mounts the plugin.)

4. **Tool names are a global namespace.** `git_status`, `git_diff`, `git_log`,
   `git_commit`, `git_branch`, `git_stash` are the names every git plugin
   reaches for. Two plugins registering the same name is a hard boot failure of
   the whole profile — and a competing plugin can register successfully while
   being broken, because bypassing `defineTool` also bypasses the authoring
   check. Before mounting this alongside another git plugin, boot in a sandbox
   first. (documented; see `docs/DESIGN.md` § Compatibility)

5. **Avoid schema keywords whose support differs by harness version.**
   `required: true` inside a property is accepted by dsh-tools `0.1.5-rc.2` and
   **rejected** by `0.1.6-alpha.2` with `UNSUPPORTED_SCHEMA`; a top-level
   `required: [...]` array is rejected by both; `enum` in a tool schema made a
   provider reject the whole function schema; every object node (including
   nested `items`) must state `additionalProperties` explicitly. This plugin
   declares none of them and enforces the same constraints in code, which also
   yields a better message (`unsupported action "x"; expected one of …`).
   (`test/schema.test.js`)

6. **A returned value must match the declared schema exactly — never `null`.**
   A `null` where the schema says `string` fails the turn with
   `INVALID_TOOL_OUTPUT` *after* git has already succeeded. Omit the field;
   `undefined` is equivalent to absent and is safe.
   (`test/tools.test.js` — "no tool returns null")

7. **Renderers run after the work is done, on the same value.** A renderer that
   reads a field its `execute` never returned throws inside the harness and
   turns a successful call into a failed turn. And because an omitted field
   arrives as `undefined`, not `null`, a `field === null` guard renders the
   literal string `undefined`. Every tool's output is driven through its own
   renderer in the suite. (`test/tools.test.js`)

8. **`git branch --format` uses the for-each-ref escape grammar** (`%1f`), not
   `git log`'s `%xXX` form. Getting it wrong fails silently: git emits the
   literal text `%x1f`, no field ever splits, and every branch is filtered out.
   Only an end-to-end test against a real git catches this.
   (`test/e2e.test.js` — "git_branch lists, creates, and switches")

9. **Output is pinned per invocation.** The 10 `-c` overrides in
   `src/exec.js` exist because each one changes the bytes this plugin parses.
   Behavioural settings (`user.name`, `core.autocrlf`, hooks) are deliberately
   *not* pinned. (`test/e2e.test.js` acceptance 5)

10. **A rename touches four places, and `cordis.patch.yml` is the one that gets
    forgotten.** `package.json`'s `name`, the repository name, the directory
    name and the `name:` of the patch row in `cordis.patch.yml` all have to
    agree. The row's value is resolved as a package name against the profile
    *at boot*, so a stale one produces `ERR_MODULE_NOT_FOUND` and a profile that
    will not start, while `--dump-config` still reports a clean, exit-0 tree. A
    sibling plugin in this family shipped exactly that. Verify with
    `bash tools/boot-check.sh`, which fails on the mutation and passes on the
    fix. (`test/` cannot see it; the boot smoke in CI is the guard)

## Platform and version matrix

| Axis | Values that must work | Why |
| --- | --- | --- |
| Harness | `0.1.5-rc.2` (stable), `0.1.6-alpha.2` (preview) | the schema DSL changed between them |
| OS | Windows, Linux | path separators, `%` expansion, line endings |
| Node | 20, 24 | `AbortSignal.any` has a fallback for older runtimes |

Windows is the platform most likely to differ and the one easiest to forget:
the shell-quoting argument does not apply here, but path joining, reserved
device names, and alternate data streams all do.

## The verification ladder

Cheapest first. Do not claim a rung you did not climb.

1. `npm test` — parsers, validators, spawn spec, tool behaviour, schemas.
2. `npm test` on Linux (WSL) — catches platform-assuming code.
3. Sandbox boot — `DSH_HOME=<throwaway>` + real `--port`. Catches registration
   conflicts and `apply()` throws.
4. Real turn — a harness turn that actually calls the tools and reports values
   you can compare against `git` run by hand. This is the only rung that
   catches a renderer or a schema mismatch the provider would reject.

Rungs 1 and 2 run in CI on every platform. Rung 3 runs in CI on the Linux legs
(`tools/boot-check.sh`): a boot needs a harness install, and the plugin manager
drives pnpm with no fallback, which the Windows image does not carry. Run rung 3
by hand on Windows whenever you touch anything that affects mounting — under Git
Bash a POSIX path handed to a native node process is rewritten (`/d/a/repo`
becomes `D:\d\a\repo`) and the harness entry point is reached through a shell
wrapper, so a scripted Windows boot can fail for reasons that are not the
plugin's. Widening the CI step to Windows needs a green Windows run to point at
first; a gate that goes red on infrastructure gets switched off. Rung 4 stays
manual because it needs a model credential.
