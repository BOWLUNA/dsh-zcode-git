# Publishing

English | [中文](PUBLISHING.zh.md)

How a release of this package is cut. It is short because most of it is
automated; the parts that are not automated are the ones that have gone wrong.

## The five guards, in this order

```bash
export PATH="$HOME/.local/bin:$PATH"     # a non-login WSL shell has no node on PATH
cd <repo>
node test/run.mjs                                  # 1) suite and counts
node tools/verify-translation-pairing.mjs --write  # 2) re-record pairing hashes
node tools/verify-doc-numbers.mjs                  # 3) documented numbers vs reality
bash -n install.sh && bash -n uninstall.sh         # 4) shell syntax
node tools/verify-version-consistency.mjs --dsh <version>   # 5) declared range vs tested
```

The order matters: change a count, then re-record the pairing, then re-check the
numbers. Doing them out of order — or skipping the middle one — produces a red
CI matrix and a hunt through code that was never wrong.

A guard that cannot fail is not a guard. Each of these has been run against a
deliberately broken copy to confirm it goes red.

## Version bump locations

`node tools/verify-doc-numbers.mjs` names every location it checks:

- `package.json`
- `SECURITY.md` support table
- `README.md` and `README.zh.md` (any stated version or range)

## Release

```bash
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push && git push origin vX.Y.Z
gh run list --repo <owner>/<repo> --limit 6
gh release view vX.Y.Z --repo <owner>/<repo>
```

The last command is not a formality. `release.yml` creates the GitHub Release
itself, so a tag push should move the repository's Releases panel — and if that
panel is still showing the previous version while the tag and the commit have
both moved, the Release step did not run. A `permissions: contents: read` on the
workflow is the usual cause; creating a Release needs `contents: write`. Note
that the Release step carries `if: always()` on purpose, so a Release is still
created when `npm publish` fails for want of credentials.

## A green publish job is not a published package

npm propagation takes a couple of minutes. Verify it propagated, then **open the
tarball**:

```bash
npm view <pkg> version
cd /tmp && rm -rf tgz && mkdir tgz && cd tgz
curl -sL "$(npm view <pkg> dist.tarball)" -o p.tgz && tar xzf p.tgz
grep -rl '<a string only this release contains>' package/
```

CI being green and npm showing the new version together only prove "something was
published". Only finding this release's code inside the tarball proves that
**this** release was.

## Market submission

The search index reads exactly one field: the `description` in
`data/plugins/<OWNER>__<repo>--<sub>.yml`. Not the README, not npm keywords.
Multi-word queries must match within that single field, and Chinese terms must
appear contiguously — so the description has to be accurate rather than
keyword-stuffed. Overstating is the one reason a submission gets rejected.

## What to tell users

pnpm applies a 24-hour release cooldown by default, so a freshly published
version resolves to the previous one **silently**. To get it immediately, pin the
version:

```bash
dsh plugin --profile web add <pkg>@X.Y.Z
```
