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
#   DSH_BIN       the dsh command; may be several words, e.g.
#                 `node node_modules/@deepseek-ai/dsh/lib/bin.js`
#                 (default: discover — `dsh` on PATH, then node_modules)
#
# Exit status: 0 only when the profile installed, the composed tree contains our
# row, the boot left the port answering, and nothing was written to stderr.
#
# Note the third condition is "the port answers", not "a listen URL was
# printed". dsh 0.1.5-rc.2 prints nothing on a successful boot while
# 0.1.6-alpha.2 prints a banner, and this package supports both. See the comment
# above section 3.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${BOOT_HOME:-$REPO/.lab/dsh-home}"
PORT="${BOOT_PORT:-31870}"
WAIT="${BOOT_TIMEOUT:-60}"

# The fallbacks below are relative to the repository.
cd "$REPO"

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

# ── Find the harness ──────────────────────────────────────────
# Do not assume `dsh` is on PATH. It is, for a machine-wide install — which is
# the local-development layout and why a bare `dsh` works by hand. In CI it is
# not: `npm install --no-save @deepseek-ai/dsh` puts the harness under
# node_modules, and `.bin/` may not even exist. Assuming cost a red build on all
# three Linux legs, and the bare `127` it produced read like a plugin fault
# rather than a missing binary. Try the candidates in order and, when all of
# them miss, say which ones were tried.
DSH_CMD=()
resolve_dsh() {
	if [ -n "${DSH_BIN:-}" ]; then
		# Deliberately word-split: DSH_BIN may be a two-word command such as
		# `node node_modules/@deepseek-ai/dsh/lib/bin.js`.
		read -r -a DSH_CMD <<<"$DSH_BIN"
		return 0
	fi
	if command -v dsh >/dev/null 2>&1; then
		DSH_CMD=(dsh)
		return 0
	fi
	if [ -x node_modules/.bin/dsh ]; then
		DSH_CMD=(node_modules/.bin/dsh)
		return 0
	fi
	if [ -f node_modules/@deepseek-ai/dsh/lib/bin.js ]; then
		DSH_CMD=(node node_modules/@deepseek-ai/dsh/lib/bin.js)
		return 0
	fi
	return 1
}

if ! resolve_dsh; then
	fail "no harness found. Tried: \$DSH_BIN, \`dsh\` on PATH, node_modules/.bin/dsh, node_modules/@deepseek-ai/dsh/lib/bin.js. Run \`npm install --no-save @deepseek-ai/dsh@<version>\` first, or set DSH_BIN."
fi

echo "repo:       $REPO"
echo "dsh:        $("${DSH_CMD[@]}" --version 2>&1 | head -1)  [${DSH_CMD[*]}]"
echo "throwaway:  $HOME_DIR"
echo "port:       $PORT"

# ── 1. Install into a throwaway profile ───────────────────────
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/profiles/web"

set +e
DSH_HOME="$HOME_DIR" "${DSH_CMD[@]}" plugin --profile web add "$REPO" >"$ADD_OUT" 2>"$ADD_ERR"
add_status=$?
set -e
[ "$add_status" -eq 0 ] || fail "plugin add exited $add_status"

# ── 2. Compose the tree (weak on its own, but free) ───────────
set +e
DSH_HOME="$HOME_DIR" "${DSH_CMD[@]}" --profile web --dump-config >"$DUMP_OUT" 2>"$DUMP_ERR"
dump_status=$?
set -e
[ "$dump_status" -eq 0 ] || fail "dump-config exited $dump_status"
# Deliberately lenient about the layout: the point is that our row is present,
# not that a heading is formatted a particular way. A strict pattern here would
# turn a cosmetic harness change into a red build.
grep -q 'dsh-zcode-git' "$DUMP_OUT" \
	|| fail "our row is absent from the composed tree — the manifest is not picking the bundle up"

# ── 3. The boot itself ────────────────────────────────────────
#
# The assertion is "the port answers", not "a listen URL was printed", and the
# difference is not pedantry. Measured on this project's own supported lines:
#
#   dsh 0.1.6-alpha.2  → stdout `dsh web: http://127.0.0.1:<port>/?token=…`
#   dsh 0.1.5-rc.2     → stdout empty; the server is up and the process stays
#                        alive, it simply does not announce itself
#
# So a guard that greps for the URL is red on one of the two lines this package
# declares support for, for a reason that is entirely about wording — and a gate
# that goes red for that gets switched off. Probing the socket measures what we
# actually care about — the plugin mounted and the server came up — and it is
# indifferent to how any version phrases its banner. The URL is still reported
# when one is printed, because it is useful in a log.
DSH_HOME="$HOME_DIR" "${DSH_CMD[@]}" --profile web --port "$PORT" --no-open >"$LOG_OUT" 2>"$LOG_ERR" &
server_pid=$!

# Connect rather than parse. curl is on the GitHub images; `/dev/tcp` is a bash
# builtin and covers a machine that has no curl.
port_answers() {
	if command -v curl >/dev/null 2>&1; then
		curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/" && return 0
		return 1
	fi
	(exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null || return 1
	exec 3<&- 2>/dev/null || true
	return 0
}

died_early=no
listening=no
waited=0
while [ "$waited" -lt "$WAIT" ]; do
	if port_answers; then listening=yes; break; fi
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
echo "boot:         $(if [ "$died_early" = yes ]; then echo 'exited on its own'; else echo "alive after ${waited}s (killed by this script)"; fi)"
echo "port ${PORT}:      $(if [ "$listening" = yes ]; then echo 'answered'; else echo 'never answered'; fi)"
echo "boot stderr:  $stderr_bytes bytes"
echo "listen url:   ${url:-(none printed — fine on 0.1.5-rc.2, which prints nothing)}"

[ "$died_early" = no ] || fail "the process exited on its own instead of serving"
[ "$listening" = yes ] \
	|| fail "nothing answered on port ${PORT} after ${WAIT}s — the plugin likely failed to load"
[ "$stderr_bytes" -eq 0 ] || fail "stderr is not empty — the harness reported a problem while booting"

printf '\n\033[32m✓ boot check passed: installed, composed, and answered on port %s%s\033[0m\n' \
	"$PORT" "${url:+ ($url)}"
