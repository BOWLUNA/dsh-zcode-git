# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for looking. This is a small plugin with a narrow purpose, and the most
useful contributions are usually a reproduction of a case that behaves wrongly,
or a test that pins down a case nobody thought about.

## Development setup

Nothing to install beyond Node — the plugin has no runtime dependencies and its
only peers are provided by the harness.

```sh
npm test
```

The suite runs with `node --test` and needs a real `git` on `PATH`; the
end-to-end layer creates throwaway repositories under the system temp
directory and removes them afterwards.

## The three guards

CI runs all three, and each catches a class of mistake the others cannot. Run
them before pushing — the repository has previously gone red on all four CI
matrix entries because a count was updated without re-recording the pairing
hashes.

```sh
node tools/verify-translation-pairing.mjs           # bilingual pairing
node tools/verify-version-consistency.mjs           # declared dsh range vs tested
node tools/verify-doc-numbers.mjs                   # documented counts vs the real run
```

- If you changed a **count** (tests, tools, pinned settings), run
  `verify-doc-numbers.mjs` and update every document it names.
- If you changed **either language file**, run
  `verify-translation-pairing.mjs --write` to re-record the pair.
- If you changed the **compatible harness range**, run
  `verify-version-consistency.mjs` — it checks that `engines.dsh` still covers
  every version the CI matrix installs.

## Documentation pairing

Every user-facing document exists twice, with equal authority:

| English | Chinese | Record |
| --- | --- | --- |
| `README.md` | `README.zh.md` | `README.i18n.yaml` |
| `CHANGELOG.md` | `CHANGELOG.zh.md` | `CHANGELOG.i18n.yaml` |
| `CONTRIBUTING.md` | `CONTRIBUTING.zh.md` | `CONTRIBUTING.i18n.yaml` |
| `SECURITY.md` | `SECURITY.zh.md` | `SECURITY.i18n.yaml` |

Neither side is a translation of the other — they are two renderings of the
same content. Each file opens with a language-switch line, and the `.i18n.yaml`
beside each pair records the git blob hash of both sides as of the last time
they were confirmed to agree.

## Invariants

Before changing anything under `src/` or the tool definitions in `index.js`,
read [`AGENTS.md`](AGENTS.md). Its "What must not break" list is not style
guidance — every item is a failure that was observed in a real harness, several
of them silently, and each one names the test that guards it.

## Commit and pull request conventions

- Commit messages use the conventional style: `type(scope): subject`
  (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`).
- A pull request that changes behaviour should say what a reader can do
  afterwards that they could not do before, and how you verified it.
- Say which harness version and platform you tested on. Behaviour differs
  across `0.1.5-rc.2` / `0.1.6-alpha.2` and across Windows / Linux, so an
  untested axis is worth naming rather than assuming.
- Screenshots only where they carry information text cannot. This plugin has no
  UI of its own, so that is rare.

## Reporting a bug

Open an issue with the harness version, your platform, the exact tool call, and
what happened. If the tool returned something wrong rather than failing, the
rendered text plus what `git` says when you run the same command by hand is the
most useful pairing. For a security issue, follow [`SECURITY.md`](SECURITY.md)
instead.
