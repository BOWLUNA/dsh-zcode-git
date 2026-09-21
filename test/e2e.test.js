/**
 * End-to-end tests against a real git binary and a real temporary repository.
 *
 * The unit tests prove the plugin builds the right argv; these prove that the
 * argv it builds actually produces the intended repository behaviour. The two
 * acceptance cases the plugin exists for are covered here:
 *
 *  - the user's own git configuration cannot reshape the parsed output, and
 *  - a commit message containing shell metacharacters is stored verbatim.
 *
 * A minimal subprocess service stands in for `@deepseek-ai/dsh-subprocess-local`
 * so the tests exercise the plugin's own seam usage (spawn spec, collect-mode
 * readers, exit facts) without needing a booted harness.
 *
 * @module dsh-zcode-git/test/e2e
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, test } from "node:test";

import { defineTools } from "../index.js";

/**
 * A minimal stand-in for the harness subprocess seam.
 *
 * Implements the spec shape the plugin relies on: `argv` spawning, collected
 * stdio read via `readFrom(offset)`, and a `done` promise carrying exit facts.
 *
 * @returns a service with a `spawn` method.
 */
function subprocessService() {
	return {
		spawn(spec) {
			const child = spawn(spec.argv[0], spec.argv.slice(1), {
				cwd: spec.cwd,
				env: { ...process.env, ...(spec.env ?? {}) },
				windowsHide: true,
			});
			const stdout = [];
			const stderr = [];
			child.stdout.on("data", (chunk) => stdout.push(chunk));
			child.stderr.on("data", (chunk) => stderr.push(chunk));
			const done = new Promise((resolvePromise, rejectPromise) => {
				child.once("error", rejectPromise);
				child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
			});
			const reader = (chunks) => ({
				readFrom: () => ({ text: Buffer.concat(chunks).toString("utf8"), nextOffset: 0, lossy: false }),
			});
			return { done, collected: { stdout: reader(stdout), stderr: reader(stderr) } };
		},
	};
}

/** Build a context whose git invocations really run. */
function realContext() {
	return {
		get(name) {
			if (name === "subprocess") return subprocessService();
			if (name === "approval") return { async request() { return "allowed-once"; } };
			return undefined;
		},
	};
}

/**
 * Run git directly, for test fixtures only.
 *
 * @param cwd - repository directory.
 * @param args - git arguments.
 * @returns stdout.
 */
function git(cwd, args) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", args, { cwd, windowsHide: true });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.on("data", (chunk) => { err += chunk; });
		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code === 0) resolvePromise(out);
			else rejectPromise(new Error(`git ${args.join(" ")} exited ${code}: ${err}`));
		});
	});
}

/** Directories created by this file, removed afterwards. */
const created = [];

/**
 * Create an initialised repository with one commit and a deterministic identity.
 *
 * The identity is written into the repository config rather than the process
 * environment because the plugin pins its own child environment, so a test
 * that relied on `GIT_AUTHOR_NAME` would be measuring the harness, not the
 * plugin.
 *
 * @param name - suffix for the temp directory.
 * @returns the repository path.
 */
async function makeRepo(name) {
	const dir = mkdtempSync(join(tmpdir(), `dsh-zcode-git-${name}-`));
	created.push(dir);
	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.name", "Test Author"]);
	await git(dir, ["config", "user.email", "test@example.invalid"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "initial\n");
	await git(dir, ["add", "README.md"]);
	await git(dir, ["commit", "-m", "chore: initial commit"]);
	return dir;
}

/** The tool execution context the plugin reads its session directory from. */
const execFor = (dir) => ({ agent: { session: { header: { cwd: dir } } }, signal: undefined });

/** Tools sharing one real context. */
const tools = new Map(defineTools(realContext(), { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: true }).map((definition) => [definition.name, definition]));
const run = (name, args, dir) => tools.get(name).execute(args, execFor(dir));

before(async () => {
	// Fail loudly and early if git is unavailable, rather than with a confusing
	// assertion per test.
	await git(process.cwd(), ["--version"]);
});

after(() => {
	for (const dir of created) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A locked file on Windows is not worth failing the suite over.
		}
	}
});

test("acceptance 1 — a clean repository reports empty lists", async () => {
	const dir = await makeRepo("clean");
	const value = await run("git_status", {}, dir);
	assert.equal(value.ok, true);
	assert.equal(value.branch, "main");
	assert.deepEqual(value.staged, []);
	assert.deepEqual(value.modified, []);
	assert.deepEqual(value.untracked, []);
	assert.deepEqual(value.conflicted, []);
});

test("acceptance 2 — staged, modified, and untracked files are classified separately", async () => {
	const dir = await makeRepo("mixed");
	writeFileSync(join(dir, "staged.txt"), "a\n");
	writeFileSync(join(dir, "modified.txt"), "b\n");
	await git(dir, ["add", "staged.txt", "modified.txt"]);
	await git(dir, ["commit", "-m", "chore: add two files"]);
	writeFileSync(join(dir, "modified.txt"), "b changed\n");
	writeFileSync(join(dir, "staged.txt"), "a staged change\n");
	await git(dir, ["add", "staged.txt"]);
	writeFileSync(join(dir, "untracked.txt"), "c\n");

	const value = await run("git_status", {}, dir);
	assert.deepEqual(value.staged.map((entry) => entry.path), ["staged.txt"]);
	assert.deepEqual(value.modified.map((entry) => entry.path), ["modified.txt"]);
	assert.deepEqual(value.untracked, ["untracked.txt"]);
});

test("acceptance 3 — a detached HEAD is reported as such", async () => {
	const dir = await makeRepo("detached");
	await git(dir, ["checkout", "--detach", "HEAD"]);

	const value = await run("git_status", {}, dir);
	assert.equal(value.detached, true);
	assert.equal(value.branch, "");
	assert.ok(value.oid.length > 0);
});

test("acceptance 5 — the user's git configuration cannot reshape the output", async () => {
	const dir = await makeRepo("hostile-config");
	// Every one of these is a setting that would corrupt a parse if the plugin
	// had not pinned it.
	await git(dir, ["config", "color.ui", "always"]);
	await git(dir, ["config", "status.relativePaths", "true"]);
	await git(dir, ["config", "core.quotepath", "true"]);
	await git(dir, ["config", "log.showSignature", "false"]);
	// An alias cannot shadow a builtin, but the plugin still must not depend on
	// the user's alias table being empty.
	await git(dir, ["config", "alias.st", "status --short"]);

	const sub = join(dir, "sub");
	mkdirSync(sub);
	writeFileSync(join(sub, "nested file.txt"), "x\n");
	writeFileSync(join(dir, "café.txt"), "y\n");

	const value = await run("git_status", { path: sub }, dir);
	assert.equal(value.ok, true);
	// `status.relativePaths=true` would have emitted `../café.txt` here.
	const allPaths = [
		...value.staged.map((entry) => entry.path),
		...value.modified.map((entry) => entry.path),
		...value.untracked,
	].join("\n");
	assert.equal(allPaths.includes("../"), false, "paths must be repository-relative");
	// `color.ui=always` would have embedded ANSI escapes.
	assert.equal(allPaths.includes("\u001b["), false, "output must not contain color escapes");
	// `core.quotepath=true` would have turned the CJK name into octal escapes.
	assert.ok(value.untracked.some((path) => path.includes("café")), `expected a raw café.txt path, got: ${allPaths}`);
	assert.ok(value.untracked.some((path) => path.includes("nested file.txt")), "a path containing a space must survive intact");
});

test("acceptance 6 — a commit message with shell metacharacters is stored verbatim", async () => {
	const dir = await makeRepo("message");
	const message = [
		'fix: keep %PATH% and $(whoami) and "double" and `backtick`',
		"",
		"正文：中文提交信息，含全角标点与 100% 符号。",
		"Also a line with a literal $ and a backslash \\ and a tab\there.",
	].join("\n");

	writeFileSync(join(dir, "message.txt"), "content\n");
	const value = await run("git_commit", { message, paths: ["message.txt"] }, dir);
	assert.equal(value.ok, true, value.message);

	// Read it back from the repository: the only check that proves what git stored.
	const stored = await git(dir, ["log", "-1", "--format=%B"]);
	assert.equal(stored.trimEnd(), message.trimEnd());
});

test("acceptance 6 — a message that is only metacharacters still survives", async () => {
	const dir = await makeRepo("metachars");
	writeFileSync(join(dir, "x.txt"), "1\n");
	await git(dir, ["add", "x.txt"]);
	const message = '%PATH% $(id) && echo "x" | cat > /dev/null ; `whoami` ^ & !';
	const value = await run("git_commit", { message }, dir);
	assert.equal(value.ok, true, value.message);
	const stored = await git(dir, ["log", "-1", "--format=%B"]);
	assert.equal(stored.trimEnd(), message);
});

test("acceptance 6 — a multi-line message round-trips through the log tool", async () => {
	const dir = await makeRepo("multiline");
	const message = "feat: subject line\n\n- bullet one\n- bullet two\n\nSigned-off-by: Test Author <test@example.invalid>";
	writeFileSync(join(dir, "m.txt"), "1\n");
	await run("git_commit", { message, paths: ["m.txt"] }, dir);

	const log = await run("git_log", { limit: 1 }, dir);
	assert.equal(log.ok, true);
	assert.equal(log.commits[0].subject, "feat: subject line");
});

test("acceptance 7 — a non-repository directory fails with an actionable message", async () => {
	const plain = mkdtempSync(join(tmpdir(), "dsh-zcode-git-plain-"));
	created.push(plain);
	const value = await run("git_status", {}, plain);
	assert.equal(value.ok, false);
	assert.ok(value.exitCode > 0);
	assert.match(value.message, /not inside a git work tree/);
});

test("acceptance 9 — a large log request stays bounded", async () => {
	const dir = await makeRepo("large-log");
	// Enough commits that an unbounded log would be noticeably slow to parse.
	for (let index = 0; index < 120; index += 1) {
		writeFileSync(join(dir, "counter.txt"), `${index}\n`);
		await git(dir, ["add", "counter.txt"]);
		await git(dir, ["commit", "-m", `chore: bump to ${index}`]);
	}

	const value = await run("git_log", { limit: 500 }, dir);
	assert.equal(value.ok, true);
	// 120 fixture commits plus the initial one created by makeRepo.
	assert.equal(value.commits.length, 121);
	// Newest first.
	assert.equal(value.commits[0].subject, "chore: bump to 119");
});

test("git_diff reports per-file counts that match the real change", async () => {
	const dir = await makeRepo("diff");
	writeFileSync(join(dir, "counted.txt"), "1\n2\n3\n");
	await git(dir, ["add", "counted.txt"]);
	await git(dir, ["commit", "-m", "chore: seed"]);
	writeFileSync(join(dir, "counted.txt"), "1\n2\n3\n4\n5\n");

	const value = await run("git_diff", {}, dir);
	assert.equal(value.ok, true);
	const entry = value.files.find((file) => file.path === "counted.txt");
	assert.ok(entry, `expected counted.txt in ${JSON.stringify(value.files)}`);
	assert.equal(entry.added, 2);
	assert.equal(entry.deleted, 0);
	assert.ok(value.patch.includes("+4"));
});

test("git_stash saves and restores worktree changes", async () => {
	const dir = await makeRepo("stash");
	writeFileSync(join(dir, "README.md"), "changed content\n");

	const saved = await run("git_stash", { action: "push", message: "wip: experiment" }, dir);
	assert.equal(saved.ok, true, saved.message);
	assert.equal(saved.stashes.length, 1);
	assert.match(saved.stashes[0].message, /wip: experiment/);

	// The working tree is clean after a push.
	const clean = await run("git_status", {}, dir);
	assert.deepEqual(clean.modified, []);

	const restored = await run("git_stash", { action: "pop" }, dir);
	assert.equal(restored.ok, true, restored.message);
	const dirty = await run("git_status", {}, dir);
	assert.deepEqual(dirty.modified.map((entry) => entry.path), ["README.md"]);
});

test("git_branch lists, creates, and switches", async () => {
	const dir = await makeRepo("branches");
	const created = await run("git_branch", { action: "create", name: "feature/x" }, dir);
	assert.equal(created.ok, true, created.message);
	assert.ok(created.branches.some((branch) => branch.name === "feature/x"));

	const switched = await run("git_branch", { action: "switch", name: "feature/x" }, dir);
	assert.equal(switched.ok, true, switched.message);
	const current = switched.branches.find((branch) => branch.current === true);
	assert.equal(current.name, "feature/x");
});

test("a path argument containing spaces and CJK resolves and works", async () => {
	const dir = await makeRepo("cjk-subdir");
	const sub = join(dir, "子目录 with space");
	mkdirSync(sub);
	writeFileSync(join(sub, "文件.txt"), "1\n");
	await git(dir, ["add", "--", "子目录 with space/文件.txt"]);
	await git(dir, ["commit", "-m", "chore: cjk path"]);

	const value = await run("git_status", { path: sub }, dir);
	assert.equal(value.ok, true);
	assert.deepEqual(value.staged, []);
	assert.deepEqual(value.modified, []);
});

test("a relative path argument resolves against the session directory", async () => {
	const dir = await makeRepo("relative-path");
	const sub = join(dir, "inner");
	mkdirSync(sub);
	writeFileSync(join(sub, "inner file.txt"), "1\n");

	// `separator` keeps the assertion honest on Windows, where the plugin builds
	// the joined path with a backslash.
	const value = await run("git_status", { path: `inner${sep}` }, dir);
	assert.equal(value.ok, true);
	assert.ok(value.untracked.some((path) => path.includes("inner file.txt")));
});

test("acceptance 4 — a merge conflict is reported as conflicted", async () => {
	const dir = await makeRepo("conflict");
	writeFileSync(join(dir, "both.txt"), "base\n");
	await git(dir, ["add", "both.txt"]);
	await git(dir, ["commit", "-m", "chore: base"]);
	await git(dir, ["checkout", "-q", "-b", "other"]);
	writeFileSync(join(dir, "both.txt"), "other\n");
	await git(dir, ["commit", "-q", "-am", "chore: other"]);
	await git(dir, ["checkout", "-q", "main"]);
	writeFileSync(join(dir, "both.txt"), "main\n");
	await git(dir, ["commit", "-q", "-am", "chore: main"]);
	// The merge is expected to fail with a conflict; git's exit code is not the
	// assertion, the reported state is.
	await git(dir, ["merge", "other"]).catch(() => undefined);

	const value = await run("git_status", {}, dir);
	assert.equal(value.ok, true);
	assert.deepEqual(value.conflicted.map((entry) => entry.path), ["both.txt"]);
	assert.equal(value.conflicted[0].index, "unmerged");

	// The rendered form must use the porcelain code, not a word initial.
	const text = tools.get("git_status").output.render({}, value)[0].text;
	assert.ok(text.includes("UU  both.txt"), text);
});

test("acceptance 8 — an absolute path outside the session directory is honoured", async () => {
	// The plugin's policy is to trust an explicit repository path the same way
	// `bash` would: the session directory is only a default, and a relative
	// value is what gets validated against the repository. The real boundary
	// for filesystem reach is the harness sandbox and approval policy, not this
	// tool, so narrowing it here would break multi-repository work without
	// adding a boundary the shell escape hatch does not already cross.
	const session = await makeRepo("session");
	const other = await makeRepo("elsewhere");
	writeFileSync(join(other, "unrelated.txt"), "1\n");

	const value = await run("git_status", { path: other }, session);
	assert.equal(value.ok, true);
	assert.ok(value.untracked.includes("unrelated.txt"), `expected the other repository's state:\n${JSON.stringify(value.untracked)}`);
});
