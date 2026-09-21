#!/usr/bin/env bash
#
# Boot check — does the plugin actually *load* into a profile?
#
# Why this exists, and why `--dump-config` is not a substitute:
#
#   `--dump-config` composes configuration; it does **not** apply plugins. This
#   repository once shipped a patch row whose `name` no longer matched the
#   package (`dsh-zcode-git` where the row still said `dsh-tool-git`).
#   `--dump-config` reported a clean tree — exit 0, empty stderr — while a real
#   boot died with ERR_MODULE_NOT_FOUND and a 6 KB stack trace. The row's
#   package is resolved against the profile *at boot*, so nothing cheaper than a
#   real `--port` boot exercises it. A green dump is not evidence of a load.
#   (Same second half: `tool "git_status" is already registered` — a
#   registration conflict — was also invisible to `--dump-config`.)
#
# Prerequisite — read this before wiring it into CI:
#
#   The plugin imports its peers (`@deepseek-ai/schemastery` and friends) from
#   its own directory. A checkout with no `node_modules` therefore fails to boot
#   for a reason that has nothing to do with the plugin. Run the same setup the
#   suite needs first:
#
#     npm install --no-save @deepseek-ai/dsh@<version>
#     node tools/link-harness-peers.mjs
#
#   Without those, this gate goes red on infrastructure and gets switched off.
#
# Usage:
#   bash tools/boot-check.sh
#   BOOT_HOME=/tmp/elsewhere BOOT_PORT=31871 bash tools/boot-check.sh
#
# Environment:
#   BOOT_HOME     throwaway harness home (default: <repo>/.lab/dsh-home)
#   BOOT_PORT     port to listen on      (default: 31870)
#   BOOT_TIMEOUT  seconds to wait for the listen URL (default: 60)
#   DSH_BIN       the dsh executable     (default: dsh)
#
# Exit status: 0 only when the profile installed, the composed tree contains our
# row, the boot printed a listen URL, and nothing was written to stderr.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${BOOT_HOME:-$REPO/.lab/dsh-home}"
PORT="${BOOT_PORT:-31870}"
WAIT="${BOOT_TIMEOUT:-60}"
DSH="${DSH_BIN:-dsh}"

WORK="$(mktemp -d)"
LOG_OUT="$WORK/boot.out"
LOG_ERR="$WORK/boot.err"
ADD_OUT="$WORK/add.out"
ADD_ERR="$WORK/add.err"
DUMP_OUT="$WORK/dump.out"
DUMP_ERR="$WORK/dump.err"
: >"$LOG_OUT"; : >"$LOG_ERR"
trap 'rm -rf "$WORK"' EXIT

fail() {
	printf '\n\033[31m✗ boot check failed: %s\033[0m\n' "$1" >&2
	printf '\n--- plugin add stdout ---\n' >&2; cat "$ADD_OUT" >&2 || true
	printf '\n--- plugin add stderr ---\n' >&2; cat "$ADD_ERR" >&2 || true
	printf '\n--- boot stdout ---\n' >&2; cat "$LOG_OUT" >&2 || true
	printf '\n--- boot stderr ---\n' >&2; cat "$LOG_ERR" >&2 || true
	exit 1
}

# ── Guard: never boot against a live harness home ─────────────
# The real home holds the user's running sessions; a boot there fights them.
resolve() { (cd "$1" 2>/dev/null && pwd) || printf '%s' "$1"; }
if [ "$(resolve "$HOME_DIR")" = "$(resolve "${HOME}/.dsh")" ]; then
	fail "refusing to boot against the live harness home ($HOME_DIR)"
fi
case "$HOME_DIR" in
	/|"$HOME"|"$HOME/") fail "refusing to use '$HOME_DIR' as a throwaway home" ;;
esac

echo "repo:       $REPO"
echo "dsh:        $("$DSH" --version 2>&1 | head -1)  [$(command -v "$DSH")]"
echo "throwaway:  $HOME_DIR"
echo "port:       $PORT"

# ── 1. Install into a throwaway profile ───────────────────────
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/profiles/web"

set +e
DSH_HOME="$HOME_DIR" "$DSH" plugin --profile web add "$REPO" >"$ADD_OUT" 2>"$ADD_ERR"
add_status=$?
set -e
[ "$add_status" -eq 0 ] || fail "plugin add exited $add_status"

# ── 2. Compose the tree (weak on its own, but free) ───────────
set +e
DSH_HOME="$HOME_DIR" "$DSH" --profile web --dump-config >"$DUMP_OUT" 2>"$DUMP_ERR"
dump_status=$?
set -e
[ "$dump_status" -eq 0 ] || fail "dump-config exited $dump_status"
# Deliberately lenient about the layout: the point is that our row is present,
# not that a heading is formatted a particular way. A strict pattern here would
# turn a cosmetic harness change into a red build.
grep -q 'dsh-zcode-git' "$DUMP_OUT" \
	|| fail "our row is absent from the composed tree — the manifest is not picking the bundle up"

# ── 3. The boot itself ────────────────────────────────────────
# Poll for the listen URL rather than sleeping for a fixed period: a healthy
# boot prints it in about a second, so waiting the full timeout on every run
# would be most of this gate's cost. A process that exits on its own is caught
# immediately instead.
DSH_HOME="$HOME_DIR" "$DSH" --profile web --port "$PORT" --no-open >"$LOG_OUT" 2>"$LOG_ERR" &
server_pid=$!

died_early=no
waited=0
while [ "$waited" -lt "$WAIT" ]; do
	if grep -q 'http://' "$LOG_OUT" 2>/dev/null; then break; fi
	if ! kill -0 "$server_pid" 2>/dev/null; then died_early=yes; break; fi
	sleep 1
	waited=$((waited + 1))
done

url="$(grep -o 'http://[^ ]*' "$LOG_OUT" 2>/dev/null | head -1 || true)"

if kill -0 "$server_pid" 2>/dev/null; then
	kill "$server_pid" 2>/dev/null || true
fi
set +e
wait "$server_pid" 2>/dev/null
set -e

stderr_bytes=$(wc -c <"$LOG_ERR" | tr -d ' ')

echo
echo "add exit:     $add_status"
echo "boot:         $(if [ "$died_early" = yes ]; then echo 'exited on its own'; else echo "still serving after ${waited}s (killed by this script)"; fi)"
echo "boot stderr:  $stderr_bytes bytes"
echo "listen url:   ${url:-(none printed)}"

[ "$died_early" = no ] || fail "the process exited on its own instead of serving"
[ -n "$url" ] || fail "no listen URL after ${WAIT}s — the plugin likely failed to load"
[ "$stderr_bytes" -eq 0 ] || fail "stderr is not empty — the harness reported a problem while booting"

printf '\n\033[32m✓ boot check passed: installed, composed, and served on %s\033[0m\n' "$url"
