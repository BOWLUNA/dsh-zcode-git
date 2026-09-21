/**
 * Rendering captured git facts as text the model reads.
 *
 * The renderers are separate from the parsers so the same structured value
 * can serve both the tool's `render` (what the model sees) and
 * `presentationMeta` (what a UI card shows) without either being derived by
 * re-parsing the other.
 *
 * @module dsh-zcode-git/render
 */

/**
 * Render a repository state.
 *
 * @param state - the value returned by `parseStatus`.
 * @returns a compact multi-line summary.
 */
export function renderStatus(state) {
	const lines = [];
	lines.push(`branch: ${describeHead(state)}`);

	for (const [label, entries] of [
		["staged", state.staged],
		["modified", state.modified],
		["conflicted", state.conflicted],
		["untracked", state.untracked],
		["ignored", state.ignored],
	]) {
		// A field the tool chose not to include arrives as `undefined`, not as
		// an empty array. Throwing here would turn a successful git call into a
		// failed turn, so every list is defaulted rather than trusted.
		const list = Array.isArray(entries) ? entries : [];
		if (list.length === 0) continue;
		lines.push(`${label} (${list.length}):`);
		for (const entry of list) lines.push(`  ${describeEntry(entry)}`);
	}

	if (lines.length === 1) lines.push("working tree clean");
	return lines.join("\n");
}

/** Porcelain letter for each status word, so a rendered entry reads like git's own two-column code. */
const STATUS_LETTERS = {
	unmodified: ".",
	modified: "M",
	typechange: "T",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	unmerged: "U",
};

/** Describe the HEAD, including the detached and unborn cases. */
function describeHead(state) {
	if (state.initial) return `(no commits yet, upstream ${state.upstream ?? "none"})`;
	if (state.detached) return `(detached at ${state.oid?.slice(0, 7) ?? "unknown"})`;
	const tracking = [];
	// An empty string means "no upstream" as much as `null` does: the tool
	// omits absent values, but a caller may hand-render one, and `upstream `
	// with nothing after it reads as a rendering fault.
	if (typeof state.upstream === "string" && state.upstream.length > 0) tracking.push(`upstream ${state.upstream}`);
	if (state.ahead > 0) tracking.push(`ahead ${state.ahead}`);
	if (state.behind > 0) tracking.push(`behind ${state.behind}`);
	return tracking.length === 0 ? state.branch ?? "(unknown)" : `${state.branch} (${tracking.join(", ")})`;
}

/**
 * Format one changed entry, keeping the rename source visible.
 *
 * The two leading characters mirror git's own porcelain columns — index state
 * then worktree state — rather than abbreviating the status words, whose first
 * letters collide (`unmodified` and `unmerged` both start with `u`).
 */
function describeEntry(entry) {
	if (typeof entry === "string") return entry;
	if (entry === undefined || entry === null) return "(unknown)";
	const index = STATUS_LETTERS[entry.index] ?? "?";
	const worktree = STATUS_LETTERS[entry.worktree] ?? "?";
	const from = entry.from === undefined ? "" : `  (from ${entry.from})`;
	return `${index}${worktree}  ${entry.path}${from}`;
}

/**
 * Render a diff result.
 *
 * @param value - the tool's output value.
 * @returns the diff text, or a summary plus the truncation note.
 */
export function renderDiff(value) {
	if (value.files === undefined || value.files.length === 0) {
		if (typeof value.patch === "string" && value.patch.length > 0) return value.patch;
		return `no changes${value.staged === true ? " staged" : ""}`;
	}
	const lines = [];
	const totals = value.files.reduce(
		(accumulator, file) => ({
			added: accumulator.added + (file.added ?? 0),
			deleted: accumulator.deleted + (file.deleted ?? 0),
		}),
		{ added: 0, deleted: 0 },
	);
	lines.push(`${value.files.length} file(s) changed, +${totals.added} -${totals.deleted}`);
	for (const file of value.files) {
		const counts = file.binary ? "binary" : `+${file.added} -${file.deleted}`;
		const from = file.from === undefined ? "" : `  (from ${file.from})`;
		lines.push(`  ${counts}  ${file.path}${from}`);
	}
	if (typeof value.patch === "string" && value.patch.length > 0) {
		lines.push("");
		lines.push(value.patch);
	}
	if (value.truncated === true) lines.push(`\n[diff truncated${value.spillPath === undefined ? "" : `; complete output at ${value.spillPath}`}]`);
	return lines.join("\n");
}

/**
 * Render a commit list.
 *
 * @param commits - the parsed log entries.
 * @returns one line per commit.
 */
export function renderLog(commits) {
	if (commits.length === 0) return "no commits";
	return commits.map((commit) => `${commit.shortHash}  ${commit.date}  ${commit.author}  ${commit.subject}`).join("\n");
}

/**
 * Render a branch list.
 *
 * @param branches - the parsed branch entries.
 * @returns one line per branch.
 */
export function renderBranches(branches) {
	if (branches.length === 0) return "no local branches";
	return branches
		.map((branch) => {
			const marker = branch.current ? "*" : " ";
			// The tool omits `upstream` when a branch has none, so the absent
			// case arrives as `undefined` as well as `null` — a `=== null` check
			// alone renders the literal text "undefined".
			const hasUpstream = typeof branch.upstream === "string" && branch.upstream.length > 0;
			return `${marker} ${branch.name}${hasUpstream ? `  -> ${branch.upstream}` : ""}`;
		})
		.join("\n");
}

/**
 * Render a stash list.
 *
 * @param stashes - the parsed stash entries.
 * @returns one line per stash.
 */
export function renderStashList(stashes) {
	if (stashes.length === 0) return "no stashes";
	return stashes.map((stash) => `${stash.ref}  ${stash.date}  ${stash.message}`).join("\n");
}

/**
 * Render a failed git invocation.
 *
 * An empty stderr is common: git can exit non-zero from a signal, or the
 * seam can report a timeout with nothing captured. Every branch therefore
 * produces something a model can act on rather than an empty string.
 *
 * @param result - the value returned by `runGit`.
 * @param toolName - the tool that failed, for the leading label.
 * @returns a short diagnostic.
 */
export function renderFailure(result, toolName) {
	if (result.message !== undefined && result.message.length > 0) return `${toolName} failed: ${result.message}`;
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	if (stderr.length > 0) return `${toolName} failed (exit ${result.exitCode}):\n${stderr}`;
	if (result.signal !== null && result.signal !== undefined) return `${toolName} was killed by signal ${result.signal}`;
	return `${toolName} failed with exit code ${result.exitCode} and produced no output`;
}
