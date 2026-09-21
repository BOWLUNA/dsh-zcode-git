/**
 * Input validation for the git tools.
 *
 * Everything here is a pure function so it can be unit-tested without a
 * repository, and everything here runs *before* an argv reaches the
 * subprocess seam.
 *
 * These checks are defence in depth, not the only line of defence. git itself
 * refuses to act on a path outside the repository, so the value of validating
 * first is that the model gets a precise, actionable message instead of
 * git's exit-128 spew, and that obviously hostile input never reaches a
 * process at all.
 *
 * @module dsh-tool-git/validate
 */

/** Bracketed ref syntax openers, which git treats specially in ref names. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Path segments Windows treats as devices regardless of extension. */
const WINDOWS_DEVICES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Validate the `paths` argument of a tool that stages or diffs files.
 *
 * Each entry must be a non-empty repository-relative path. Absolute paths are
 * rejected rather than silently reinterpreted: a model that passes
 * `/etc/passwd` or `C:\Users\me\.ssh` has misunderstood the tool, and quietly
 * resolving it relative to the repository would produce a confusing no-op.
 *
 * Windows-specific hazards are checked because Node runs this plugin on
 * Windows hosts, where the same string can mean two different files:
 * `C:foo` is drive-relative (resolves against that drive's current directory)
 * and `file.txt:stream` addresses an NTFS alternate data stream rather than
 * `file.txt`.
 *
 * @param paths - the candidate list, possibly `undefined`.
 * @returns an error message, or `null` when the list is acceptable.
 */
export function validateRepoRelativePaths(paths) {
	if (paths === undefined || paths === null) return null;
	if (!Array.isArray(paths)) return "`paths` must be an array of repository-relative path strings";
	for (const entry of paths) {
		const problem = validateRepoRelativePath(entry);
		if (problem !== null) return problem;
	}
	return null;
}

/**
 * Validate one repository-relative path.
 *
 * @param path - the candidate, of unknown runtime type.
 * @returns an error message, or `null` when acceptable.
 */
export function validateRepoRelativePath(path) {
	if (typeof path !== "string") return `each path must be a string; received ${typeof path}`;
	if (path.length === 0) return "paths must not be empty strings";
	if (CONTROL_CHARACTERS.test(path)) {
		// A NUL here would truncate the argument inside the C layer; letting it
		// through means the process sees a different path than the agent asked for.
		return `path ${JSON.stringify(path)} contains a control character`;
	}

	// Normalize separators so a Windows-style input is judged by the same rules
	// as a POSIX-style one — otherwise `..\\..\\x` slips past a `/`-only check.
	const normalized = path.replace(/\\/g, "/");

	// A UNC path must be checked before the single-slash case, since
	// `\\server\share` normalizes to `//server/share` and would otherwise be
	// reported as an ordinary absolute path.
	if (normalized.startsWith("//")) {
		return `path ${JSON.stringify(path)} is a UNC path; use a path relative to the repository root`;
	}
	if (normalized.startsWith("/")) {
		return `path ${JSON.stringify(path)} is absolute; use a path relative to the repository root`;
	}
	// `C:foo` (drive-relative) and `C:/foo` (drive-absolute) both start with a
	// single letter and a colon, but only the latter has a separator. Both are
	// rejected: the first silently resolves against that drive's cwd.
	if (/^[A-Za-z]:/.test(normalized)) {
		return `path ${JSON.stringify(path)} is a drive-absolute path; use a path relative to the repository root`;
	}
	if (normalized.split("/").some((segment) => segment === "..")) {
		return `path ${JSON.stringify(path)} escapes the repository root via ".."`;
	}
	if (process.platform === "win32") {
		// An alternate data stream is a separate file that `dir` and most
		// tooling show as part of the base name.
		if (normalized.includes(":") && !/^[A-Za-z]:/.test(normalized)) {
			return `path ${JSON.stringify(path)} addresses an NTFS alternate data stream`;
		}
		const stem = normalized.split("/").at(-1)?.replace(/\.[^.]*$/, "").toLowerCase();
		if (stem !== undefined && WINDOWS_DEVICES.has(stem)) {
			return `path ${JSON.stringify(path)} names a reserved Windows device`;
		}
	}
	return null;
}

/**
 * Validate a commit message.
 *
 * Newlines are allowed and preserved — a subject plus body is the normal case,
 * and the whole point of building the argv as an array is that a newline never
 * needs to survive a shell. NUL is rejected because it cannot survive the
 * platform call at all, so accepting it would silently commit a truncated
 * message.
 *
 * @param message - the candidate message.
 * @param options - `maxLength` overrides the 10,000 character ceiling.
 * @returns an error message, or `null` when acceptable.
 */
export function validateCommitMessage(message, options = {}) {
	const maxLength = options.maxLength ?? 10_000;
	if (typeof message !== "string") return `\`message\` must be a string; received ${typeof message}`;
	if (message.trim().length === 0) return "`message` must not be empty or whitespace-only";
	if (message.includes("\u0000")) return "`message` must not contain a NUL character";
	if (message.length > maxLength) return `\`message\` is ${message.length} characters; the limit is ${maxLength}`;
	return null;
}

/**
 * Validate a branch name.
 *
 * This mirrors `git check-ref-format --branch` rather than shelling out to it,
 * so the tool can report every problem in one message. git re-checks anyway;
 * this exists to fail fast and explain.
 *
 * @param branch - the candidate branch name.
 * @returns an error message, or `null` when acceptable.
 */
export function validateBranchName(branch) {
	if (typeof branch !== "string") return `\`name\` must be a string; received ${typeof branch}`;
	if (branch.length === 0) return "`name` must not be empty";
	if (CONTROL_CHARACTERS.test(branch)) return "`name` must not contain control characters";
	if (/[\s~^:?*[\]\\]/.test(branch)) {
		return `\`name\` ${JSON.stringify(branch)} contains a character git forbids in ref names (space ~ ^ : ? * [ ] \\)`;
	}
	if (branch.includes("..")) return `\`name\` ${JSON.stringify(branch)} must not contain ".."`;
	if (branch.includes("@{")) return "`name` must not contain the sequence \"@{\"";
	if (branch.startsWith("/") || branch.endsWith("/")) return "`name` must not begin or end with \"/\"";
	if (branch.startsWith(".") || branch.endsWith(".")) return "`name` must not begin or end with \".\"";
	if (branch.endsWith(".lock")) return "`name` must not end with \".lock\"";
	if (branch.includes("//")) return "`name` must not contain consecutive slashes";
	if (branch === "@") return "`name` must not be the single character \"@\"";
	return null;
}

/**
 * Validate a revision-ish argument (a ref, commit, or range) that is passed
 * through to git verbatim.
 *
 * The value is never interpolated into a shell string, so the risk is not
 * command injection but argument-position injection: a value beginning with
 * `-` would be read by git as an option. The `--` separator handles paths, but
 * revisions appear before it, so a leading dash is rejected here.
 *
 * @param revision - the candidate revision.
 * @param label - parameter name used in the message.
 * @returns an error message, or `null` when acceptable.
 */
export function validateRevision(revision, label = "revision") {
	if (typeof revision !== "string") return `\`${label}\` must be a string; received ${typeof revision}`;
	if (revision.length === 0) return `\`${label}\` must not be empty`;
	if (CONTROL_CHARACTERS.test(revision)) return `\`${label}\` must not contain control characters`;
	if (revision.startsWith("-")) {
		return `\`${label}\` ${JSON.stringify(revision)} must not begin with "-", which git would read as an option`;
	}
	return null;
}

/**
 * Clamp a model-supplied integer into a safe range.
 *
 * Models routinely pass `limit: 0`, `limit: -1`, or `limit: 100000`; each
 * silently does something surprising (git treats a non-positive `--max-count`
 * as unlimited, and a huge one stalls the turn on a large repository).
 *
 * @param value - the candidate.
 * @param fallback - value used when the input is absent or not a number.
 * @param minimum - inclusive lower bound.
 * @param maximum - inclusive upper bound.
 * @returns a usable integer.
 */
export function clampInteger(value, fallback, minimum, maximum) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
