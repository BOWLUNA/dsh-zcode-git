/**
 * Pure parsers for git's machine-readable output.
 *
 * Every parser in this module consumes a format that git guarantees to be
 * stable, and none of them parse human-readable output. That is deliberate:
 * `git status`, `git log`, and friends change with terminal width, locale,
 * `core.pager`, `color.ui`, and `core.quotepath`, so scraping them is how a
 * tool silently starts returning wrong answers on a user's machine but not on
 * the author's.
 *
 * A second rule: path-bearing records are consumed in NUL-delimited (`-z`)
 * form wherever git offers one. `-z` disables C-style path quoting entirely,
 * so spaces, tabs, newlines, non-ASCII names, and (on Windows) backslashes all
 * survive byte-for-byte instead of arriving as `"a\342\202\254b"`.
 *
 * @module dsh-tool-git/parse
 */

/**
 * Split NUL-delimited output into records.
 *
 * Written as a scan rather than `text.split("\0")` because these buffers can
 * be megabytes (a 500-commit log) and the scan avoids materializing two
 * intermediate arrays plus the split's regex work.
 *
 * @param text - raw NUL-delimited output.
 * @returns the records, with the empty tail record dropped.
 */
export function splitNul(text) {
	const records = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) !== 0) continue;
		records.push(text.slice(start, index));
		start = index + 1;
	}
	if (start < text.length) records.push(text.slice(start));
	return records;
}

/** Map a porcelain-v2 status character to a stable word. */
const CODE_WORDS = {
	".": "unmodified",
	M: "modified",
	T: "typechange",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
};

/**
 * Expand a porcelain-v2 two-character status field.
 *
 * The first character describes the index (HEAD vs. index) and the second
 * describes the working tree (index vs. worktree), so `M ` and ` M` are a
 * staged edit and an unstaged edit respectively and `MM` is both. Callers need
 * that split to route a file into `staged` or `modified`.
 *
 * @param xy - the two-character field.
 * @returns the index-side and worktree-side words.
 */
function expandStatusPair(xy) {
	return {
		index: CODE_WORDS[xy[0]] ?? "unknown",
		worktree: CODE_WORDS[xy[1]] ?? "unknown",
	};
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * Porcelain v2 is used rather than v1 because v1 reports a rename as a bare
 * `R  old -> new` string, which is ambiguous once either name contains ` -> `,
 * and because v2 carries the upstream and ahead/behind facts in `# branch.*`
 * headers instead of only in a `## ` line that v1 omits in some states.
 *
 * @param text - raw output of the command above.
 * @returns the repository state, with every list present even when empty.
 */
export function parseStatus(text) {
	const state = {
		branch: null,
		detached: false,
		oid: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		initial: false,
		staged: [],
		modified: [],
		untracked: [],
		conflicted: [],
		ignored: [],
	};

	const records = splitNul(text);
	/** A `2 ` record is followed by its original path as the next record. */
	let expectingRenameSource = false;

	for (const record of records) {
		if (record.length === 0) continue;

		if (expectingRenameSource) {
			expectingRenameSource = false;
			const previous = state.staged.at(-1) ?? state.modified.at(-1);
			if (previous !== undefined) previous.from = record;
			continue;
		}

		// `# branch.*` headers. Values are read with slice rather than split so
		// an upstream ref containing a space cannot lose its tail.
		if (record.startsWith("# branch.oid ")) {
			const oid = record.slice("# branch.oid ".length);
			state.initial = oid === "(initial)";
			state.oid = state.initial ? null : oid;
			continue;
		}
		if (record.startsWith("# branch.head ")) {
			const head = record.slice("# branch.head ".length);
			state.detached = head === "(detached)";
			state.branch = state.detached ? null : head;
			continue;
		}
		if (record.startsWith("# branch.upstream ")) {
			state.upstream = record.slice("# branch.upstream ".length);
			continue;
		}
		if (record.startsWith("# branch.ab ")) {
			// "# branch.ab +<ahead> -<behind>" — the first two tokens are the
			// marker itself, so the counts start at index 2.
			const [, , ahead, behind] = record.split(" ");
			state.ahead = toCount(ahead);
			state.behind = toCount(behind);
			continue;
		}
		if (record.startsWith("# ")) continue;

		const kind = record[0];
		const xy = record.slice(2, 4);
		const status = expandStatusPair(xy);

		switch (kind) {
			case "1": {
				// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
				const entry = { path: splitFields(record, 8), ...status };
				route(state, status, entry);
				break;
			}
			case "2": {
				// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
				const entry = { path: splitFields(record, 9), ...status };
				route(state, status, entry);
				expectingRenameSource = true;
				break;
			}
			case "u": {
				// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
				state.conflicted.push({ path: splitFields(record, 10), ...status });
				break;
			}
			case "?":
				state.untracked.push(record.slice(2));
				break;
			case "!":
				state.ignored.push(record.slice(2));
				break;
			default:
				break;
		}
	}

	return state;
}

/**
 * Slice the path out of a fixed-prefix porcelain record.
 *
 * The leading fields of `1 `/`2 `/`u ` records are space-separated but the
 * trailing path is not escaped, so the path must be recovered as "everything
 * after field N" rather than as one split token — otherwise `my file.txt`
 * becomes two entries.
 *
 * @param record - one porcelain v2 record.
 * @param fieldCount - number of leading fields before the path.
 * @returns the path, unmodified.
 */
function splitFields(record, fieldCount) {
	let seen = 0;
	for (let index = 0; index < record.length; index += 1) {
		if (record.charCodeAt(index) !== 32) continue;
		seen += 1;
		if (seen === fieldCount) return record.slice(index + 1);
	}
	return "";
}

/** Route a tracked entry into the staged or unstaged list based on its XY pair. */
function route(state, status, entry) {
	const inIndex = status.index !== "unmodified";
	const inWorktree = status.worktree !== "unmodified";
	if (inIndex) state.staged.push(entry);
	// A file can be in both lists (`MM`); the two are separate facts about it.
	if (inWorktree) state.modified.push(inIndex ? { ...entry } : entry);
}

/** Turn `+3` / `-2` into a non-negative count. */
function toCount(token) {
	if (token === undefined) return 0;
	const value = Number.parseInt(token.replace(/^[+-]/, ""), 10);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * `--numstat` is preferred over `--stat` because `--stat` renders a
 * human-oriented histogram whose column widths depend on terminal width and
 * whose file names are truncated with `...` under narrow output.
 *
 * @param text - raw `--numstat -z` output. Each record is either
 *   `<added>\t<deleted>\t<path>` or, for a rename, `<a>\t<d>\t\0<old>\0<new>`.
 * @returns per-file counts.
 */
export function parseNumstat(text) {
	const records = splitNul(text);
	const files = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length === 0) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const added = record.slice(0, firstTab);
		const deleted = record.slice(firstTab + 1, secondTab);
		let path = record.slice(secondTab + 1);
		let from;
		// A rename record ends at its second tab, so the two paths arrive as
		// their own following records.
		if (path.length === 0) {
			from = records[index + 1];
			path = records[index + 2] ?? "";
			index += 2;
		}
		files.push({
			path,
			...from === undefined ? {} : { from },
			// `-` marks a binary file, which has no line counts.
			added: added === "-" ? null : Number.parseInt(added, 10),
			deleted: deleted === "-" ? null : Number.parseInt(deleted, 10),
			binary: added === "-" || deleted === "-",
		});
	}
	return files;
}

/**
 * Parse `git log -z --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s`.
 *
 * Records are NUL-separated and fields are US-separated (`%x1f`), so a subject
 * containing tabs, newlines, or the literal text of another field cannot shift
 * the parse. `%aI` is the strict ISO-8601 author date, which sorts
 * lexicographically and carries the offset — unlike `%ad`, whose rendering
 * follows the user's `log.date`.
 *
 * @param text - raw output of the command above.
 * @returns one entry per commit.
 */
export function parseLog(text) {
	return splitNul(text)
		.filter((record) => record.length > 0)
		.map((record) => {
			const fields = record.split("\x1f");
			return {
				hash: fields[0] ?? "",
				shortHash: fields[1] ?? "",
				author: fields[2] ?? "",
				date: fields[3] ?? "",
				subject: fields.slice(4).join("\x1f"),
			};
		});
}

/**
 * Parse `git branch --format=%(HEAD)%x1f%(refname:short)%x1f%(upstream:short)%x1f%(objectname:short)`.
 *
 * The `for-each-ref` field format is used instead of plain `git branch`
 * because the default output decorates the current branch with `*` and colors
 * it under `color.ui=always`, and a branch named `*foo` would be
 * indistinguishable from that decoration.
 *
 * @param text - raw output of the command above.
 * @returns one entry per local branch.
 */
export function parseBranches(text) {
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const fields = line.split("\x1f");
			return {
				current: fields[0] === "*",
				name: fields[1] ?? "",
				upstream: fields[2] === undefined || fields[2].length === 0 ? null : fields[2],
				commit: fields[3] ?? "",
			};
		})
		.filter((branch) => branch.name.length > 0);
}

/**
 * Parse `git stash list --format=%gd%x1f%gs%x1f%aI -z`.
 *
 * @param text - raw output of the command above.
 * @returns one entry per stash, newest first.
 */
export function parseStashList(text) {
	return splitNul(text)
		.filter((record) => record.length > 0)
		.map((record) => {
			const fields = record.split("\x1f");
			return {
				ref: fields[0] ?? "",
				message: fields[1] ?? "",
				date: fields[2] ?? "",
			};
		});
}
