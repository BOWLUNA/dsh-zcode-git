#!/usr/bin/env bash
# Remove dsh-zcode-git from a dsh profile.
#
# Usage:
#   ./uninstall.sh                    # web profile
#   ./uninstall.sh --profile headless
#
# Mirrors install.sh: the same DSH_HOME caveat applies, and the same "base
# bundles must still be there afterwards" assertion runs at the end.
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
	exit 1
}

PKG_NAME="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$ROOT/package.json")"
MANIFEST="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/package.json"

echo "==> removing $PKG_NAME from profile \"$PROFILE\""

BUNDLES_BEFORE="$(node -e '
	const fs = require("fs");
	const path = process.argv[1];
	if (!fs.existsSync(path)) { process.stdout.write("[]"); process.exit(0); }
	process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(path, "utf8")).dsh?.profile?.bundles ?? []));
' "$MANIFEST")"

# `|| true` because removing something that is already absent is a successful
# outcome for an uninstaller, not an error to stop on.
dsh plugin --profile "$PROFILE" remove "$PKG_NAME" || true

node - "$MANIFEST" "$PKG_NAME" "$BUNDLES_BEFORE" <<'NODE'
const fs = require("node:fs");
const [manifestPath, name, beforeRaw] = process.argv.slice(2);
if (!fs.existsSync(manifestPath)) {
	console.log("    manifest is gone — nothing left to check");
	process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundles = manifest.dsh?.profile?.bundles ?? [];
if (bundles.includes(name)) {
	console.error(`    FAILED: ${name} is still in the bundle list: ${JSON.stringify(bundles)}`);
	process.exit(1);
}
// Every entry that existed before must still exist, except the one being removed.
const collateral = JSON.parse(beforeRaw).filter((entry) => entry !== name && !bundles.includes(entry));
if (collateral.length > 0) {
	console.error(`    FAILED: the removal also dropped: ${JSON.stringify(collateral)}`);
	console.error("    Restore them before starting dsh — a missing base bundle boots a harness with no services.");
	process.exit(1);
}
console.log(`    bundles after removal: ${JSON.stringify(bundles)}`);
NODE

echo "==> self-check: the profile still composes"
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
dsh --profile "$PROFILE" --dump-config >"$DUMP" 2>/dev/null || {
	echo "    FAILED: dsh --profile $PROFILE --dump-config did not run after the removal." >&2
	exit 1
}
ROWS="$(grep -c '^- id: ' "$DUMP" || true)"
echo "    composed tree: $ROWS rows"

cat <<EOF

Removed. Restart dsh.

EOF
