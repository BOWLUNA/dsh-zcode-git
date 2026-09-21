## What this changes

<!-- One or two sentences: what can a reader do afterwards that they could not do before? -->

## Tested on

<!--
Behaviour differs across 0.1.5-rc.2 / 0.1.6-alpha.2 and across Windows / Linux. An untested
axis is worth naming rather than assuming — say which ones you did not cover.
-->

- dsh:
- OS:
- Node:

## Checklist

- [ ] `node test/run.mjs` is green
- [ ] `node tools/verify-translation-pairing.mjs` is green (`--write` run if a language file changed)
- [ ] `node tools/verify-doc-numbers.mjs` is green
- [ ] `node tools/verify-version-consistency.mjs --dsh <version>` is green
- [ ] `bash -n install.sh && bash -n uninstall.sh`
- [ ] Nothing in the "What must not break" list of [`AGENTS.md`](AGENTS.md) is violated
- [ ] `npm pack --dry-run --json` still matches the `files` allowlist
- [ ] No credentials anywhere in the diff
