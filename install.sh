#!/usr/bin/env bash
# Install dsh-tool-git into a dsh profile.
#
# Usage:
#   ./install.sh                    # web profile
#   ./install.sh --profile headless
#
# Needs the `dsh` CLI on PATH (desktop builds ship it inside the app — see the
# README's Install section) and, in practice, DSH_HOME pointed at the harness
# you actually use: without it the CLI resolves the data directory itself and
# can install into an unrelated one.
set -euo pipefail

PROFILE=web
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
		-h | --help) sed -n '2,9p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

command -v dsh >/dev/null 2>&1 || {
	echo "error: the dsh CLI is not on PATH." >&2
	echo "  Desktop builds ship it inside the app rather than linking it; see the README." >&2
	exit 1
}

if [ -z "${DSH_HOME:-}" ]; then
	echo "warning: DSH_HOME is unset — the CLI will resolve the harness data directory on its own." >&2
	echo "         If the plugin does not show up afterwards, set DSH_HOME and re-run." >&2
fi

# Read the package name from the manifest rather than hard-coding it, so a
# rename cannot leave the script installing something that no longer exists.
PKG_NAME="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$ROOT/package.json")"
MANIFEST="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/package.json"

echo "==> installing $PKG_NAME into profile \"$PROFILE\""

# Record the bundle list before touching anything, so the install can be held to
# "only ever adds". A plugin that silently drops the in-box bundles leaves a
# harness that boots with no services — and the install still exits 0.
BUNDLES_BEFORE="$(node -e '
	const fs = require("fs");
	const path = process.argv[1];
	if (!fs.existsSync(path)) { process.stdout.write("[]"); process.exit(0); }
	process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(path, "utf8")).dsh?.profile?.bundles ?? []));
' "$MANIFEST")"

dsh plugin --profile "$PROFILE" add "$ROOT"

node - "$MANIFEST" "$PKG_NAME" "$BUNDLES_BEFORE" <<'NODE'
const fs = require("node:fs");
const [manifestPath, name, beforeRaw] = process.argv.slice(2);
if (!fs.existsSync(manifestPath)) {
	console.error(`    self-check skipped: ${manifestPath} does not exist`);
	process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundles = manifest.dsh?.profile?.bundles ?? [];
const dropped = JSON.parse(beforeRaw).filter((entry) => !bundles.includes(entry));
if (dropped.length > 0) {
	console.error(`    FAILED: the install removed bundle entries: ${JSON.stringify(dropped)}`);
	console.error("    Put them back in the profile package.json before starting dsh.");
	process.exit(1);
}
if (!bundles.includes(name)) {
	console.error(`    FAILED: ${name} is absent from the bundle list: ${JSON.stringify(bundles)}`);
	process.exit(1);
}
console.log(`    bundles: ${JSON.stringify(bundles)}`);
NODE

# Composition check. This proves the row exists and that the tree did not
# collapse — it does NOT prove the plugin loads: --dump-config composes
# configuration and never calls apply(). A tool-name collision with another
# plugin only surfaces on a real boot, which is why the last line of output
# below tells the user to do one.
echo "==> self-check: composing the profile"
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
dsh --profile "$PROFILE" --dump-config >"$DUMP" 2>/dev/null || {
	echo "    FAILED: dsh --profile $PROFILE --dump-config did not run." >&2
	exit 1
}
node - "$DUMP" "$PKG_NAME" <<'NODE'
const fs = require("node:fs");
const [dumpPath, pkg] = process.argv.slice(2);
const dump = fs.readFileSync(dumpPath, "utf8");
const rows = (dump.match(/^- id: /gm) ?? []).length;
// Deliberately loose: a collapsed tree is a handful of rows, a healthy one hundreds.
const MIN_ROWS = 20;
if (!dump.includes(`name: ${pkg}`)) {
	console.error(`    FAILED: ${pkg} has no row in the composed tree.`);
	process.exit(1);
}
if (rows < MIN_ROWS) {
	console.error(`    FAILED: only ${rows} rows composed — the base bundles look missing.`);
	process.exit(1);
}
console.log(`    composed tree: ${rows} rows, ${pkg} present`);
NODE

cat <<EOF

Installed. Restart dsh — bundle plugins are read while the profile is composed at boot.

  - The tools appear in every new session as git_status, git_diff, git_log,
    git_branch, git_commit and git_stash.
  - Boot once and check stderr before relying on it. A tool-name collision with
    another git plugin fails the whole profile at startup, and --dump-config
    cannot see it:

      dsh --profile $PROFILE --port 31870 --no-open

  - Do not install a second plugin that registers the same tool names. If one is
    already present, remove it first.

EOF
