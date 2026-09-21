import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBranches, parseLog, parseNumstat, parseStashList, parseStatus, splitNul } from "../src/parse.js";

/** Join records the way git's `-z` formats do: NUL after every record. */
const z = (...records) => records.map((record) => `${record}\0`).join("");

test("splitNul drops the empty tail record", () => {
	assert.deepEqual(splitNul("a\0b\0"), ["a", "b"]);
	// No trailing NUL: the final record is still a record.
	assert.deepEqual(splitNul("a\0b"), ["a", "b"]);
	assert.deepEqual(splitNul(""), []);
	// Interior empties are real records for git's formats and must survive.
	assert.deepEqual(splitNul("a\0\0b\0"), ["a", "", "b"]);
});

test("parseStatus reads branch headers", () => {
	const state = parseStatus(
		z(
			"# branch.oid 1111111111111111111111111111111111111111",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -3",
		),
	);
	assert.equal(state.branch, "main");
	assert.equal(state.detached, false);
	assert.equal(state.oid, "1111111111111111111111111111111111111111");
	assert.equal(state.upstream, "origin/main");
	assert.equal(state.ahead, 2);
	assert.equal(state.behind, 3);
	assert.deepEqual(state.staged, []);
	assert.deepEqual(state.modified, []);
	assert.deepEqual(state.untracked, []);
	assert.deepEqual(state.conflicted, []);
});

test("parseStatus separates index-side from worktree-side changes", () => {
	const state = parseStatus(
		z(
			"# branch.head main",
			// X=M, Y=. — staged only.
			"1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/staged.js",
			// X=., Y=M — worktree only.
			"1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/modified.js",
			// X=M, Y=M — both, and it must appear in both lists.
			"1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/both.js",
		),
	);
	assert.deepEqual(state.staged.map((entry) => entry.path), ["src/staged.js", "src/both.js"]);
	assert.deepEqual(state.modified.map((entry) => entry.path), ["src/modified.js", "src/both.js"]);
	assert.equal(state.staged[0].index, "modified");
	assert.equal(state.staged[0].worktree, "unmodified");
	assert.equal(state.modified[0].index, "unmodified");
	assert.equal(state.modified[0].worktree, "modified");
});

test("parseStatus keeps paths containing spaces intact", () => {
	const state = parseStatus(
		z(
			"# branch.head main",
			"1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb docs/my long file name.md",
			"? an untracked file with spaces.txt",
		),
	);
	assert.deepEqual(state.staged.map((entry) => entry.path), ["docs/my long file name.md"]);
	assert.deepEqual(state.untracked, ["an untracked file with spaces.txt"]);
});

test("parseStatus reads the rename source from the following record", () => {
	const state = parseStatus(
		z(
			"# branch.head main",
			"2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new name.js",
			"src/old name.js",
		),
	);
	assert.equal(state.staged.length, 1);
	assert.equal(state.staged[0].path, "src/new name.js");
	assert.equal(state.staged[0].from, "src/old name.js");
});

test("parseStatus handles the unmerged record", () => {
	const state = parseStatus(
		z(
			"# branch.head main",
			"u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.js",
		),
	);
	assert.deepEqual(state.conflicted.map((entry) => entry.path), ["src/conflict.js"]);
	assert.equal(state.conflicted[0].index, "unmerged");
});

test("parseStatus reports a detached HEAD and an unborn branch", () => {
	const detached = parseStatus(z("# branch.oid 2222222222222222222222222222222222222222", "# branch.head (detached)"));
	assert.equal(detached.detached, true);
	assert.equal(detached.branch, null);

	const initial = parseStatus(z("# branch.oid (initial)", "# branch.head main"));
	assert.equal(initial.initial, true);
	assert.equal(initial.oid, null);
});

test("parseStatus ignores ignored entries in the tracked lists", () => {
	const state = parseStatus(z("# branch.head main", "! build/output.bin"));
	assert.deepEqual(state.ignored, ["build/output.bin"]);
	assert.deepEqual(state.untracked, []);
});

test("parseNumstat reads counts and marks binary files", () => {
	const files = parseNumstat(z("12\t3\tsrc/a.js", "-\t-\tassets/logo.png"));
	assert.deepEqual(files[0], { path: "src/a.js", added: 12, deleted: 3, binary: false });
	assert.equal(files[1].path, "assets/logo.png");
	assert.equal(files[1].binary, true);
	assert.equal(files[1].added, null);
});

test("parseNumstat reads the two-record form of a rename", () => {
	const files = parseNumstat(z("4\t1\t", "src/old.js", "src/new.js"));
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/new.js");
	assert.equal(files[0].from, "src/old.js");
	assert.equal(files[0].added, 4);
});

test("parseLog preserves subjects that look like other fields", () => {
	// Fields are US-separated (`%x1f`) and records NUL-separated — the exact
	// shape produced by `--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s -z`.
	const output = z(
		"aaaa\x1f1111111\x1fAlice\x1f2026-09-21T10:00:00+08:00\x1ffix: keep \t tabs",
		"bbbb\x1f2222222\x1fBob\x1f2026-09-20T09:00:00+08:00\x1ffeat: 中文主题与 %PATH% 与 $()",
	);
	const commits = parseLog(output);
	assert.equal(commits.length, 2);
	assert.equal(commits[0].hash, "aaaa");
	assert.equal(commits[0].shortHash, "1111111");
	assert.equal(commits[0].author, "Alice");
	assert.equal(commits[0].date, "2026-09-21T10:00:00+08:00");
	// A tab inside the subject must not split it into more fields.
	assert.equal(commits[0].subject, "fix: keep \t tabs");
	assert.equal(commits[1].subject, "feat: 中文主题与 %PATH% 与 $()");
});

test("parseLog tolerates an empty log", () => {
	assert.deepEqual(parseLog(""), []);
});

test("parseBranches marks the current branch from the HEAD field", () => {
	const branches = parseBranches(
		["*\x1fmain\x1forigin/main\x1fabc1234", " \x1ffeature/x\x1f\x1fdef5678"].join("\n"),
	);
	assert.equal(branches.length, 2);
	assert.deepEqual(branches[0], { current: true, name: "main", upstream: "origin/main", commit: "abc1234" });
	assert.deepEqual(branches[1], { current: false, name: "feature/x", upstream: null, commit: "def5678" });
});

test("parseBranches is unaffected by a branch whose name starts with an asterisk", () => {
	// The default `git branch` output would render this as `* *odd` and be
	// indistinguishable from the current-branch marker.
	const branches = parseBranches(" \x1f*odd\x1f\x1fabc1234");
	assert.equal(branches[0].name, "*odd");
	assert.equal(branches[0].current, false);
});

test("parseStashList reads refs, messages, and dates", () => {
	const stashes = parseStashList(z("stash@{0}\x1fWIP on main: abc123 subject\x1f2026-09-21T10:00:00+08:00", "stash@{1}\x1f\x1f2026-09-20T10:00:00+08:00"));
	assert.equal(stashes.length, 2);
	assert.equal(stashes[0].ref, "stash@{0}");
	assert.equal(stashes[0].message, "WIP on main: abc123 subject");
	assert.equal(stashes[1].message, "");
});
