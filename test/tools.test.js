import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTools } from "../index.js";

/** Settings equal to the plugin defaults, so tests never depend on Config defaults drifting. */
const SETTINGS = { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: true };

/** Canned git output, selected by the subcommand being run. */
const RESPONSES = {
	status: "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0# branch.ab +1 -0\0",
	diff: "1\t0\tsrc/a.js\0",
	log: "aaaa\x1f1111111\x1fAlice\x1f2026-09-21T10:00:00+08:00\x1ffix: something\0",
	// One branch tracks an upstream and one does not, so the null-vs-omitted
	// path is exercised by every test that reads this fixture.
	branch: "*\x1fmain\x1forigin/main\x1fabc1234\n \x1ffeature/no-upstream\x1f\x1fdef5678\n",
	commit: "",
	add: "",
	"rev-parse": "abc1234\n",
	stash: "stash@{0}\x1fWIP on main\x1f2026-09-21T10:00:00+08:00\0",
};

/**
 * Identify the git subcommand, stepping over the pinned `-c key=value` pairs.
 *
 * @param argv - the full argv the plugin handed to the subprocess seam.
 * @returns the subcommand, or `null` when none is present.
 */
function subcommandOf(argv) {
	let index = 1;
	while (index < argv.length) {
		if (argv[index] === "-c") {
			index += 2;
			continue;
		}
		return argv[index];
	}
	return null;
}

/**
 * Build a context that records specs and approval requests.
 *
 * @param options - `approvalOutcome` overrides the decision; `noApproval`
 *   removes the service entirely.
 * @returns the context plus the two recording arrays.
 */
function harness(options = {}) {
	const specs = [];
	const approvals = [];
	const ctx = {
		get(name) {
			if (name === "subprocess") {
				return {
					spawn(spec) {
						specs.push(spec);
						const subcommand = subcommandOf(spec.argv);
						const text = RESPONSES[subcommand] ?? "";
						return {
							done: Promise.resolve({ exitCode: 0, signal: null }),
							collected: {
								stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
								stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
							},
						};
					},
				};
			}
			if (name === "approval" && options.noApproval !== true) {
				return {
					async request(request) {
						approvals.push(request);
						return options.approvalOutcome ?? "allowed-once";
					},
				};
			}
			return undefined;
		},
	};
	return { ctx, specs, approvals };
}

/** Build the tool map once so every test shares the same definitions. */
function toolsFor(options = {}) {
	const { ctx, specs, approvals } = harness(options);
	const definitions = defineTools(ctx, SETTINGS);
	return {
		specs,
		approvals,
		tools: new Map(definitions.map((definition) => [definition.name, definition])),
	};
}

/** The tool execution context the plugin reads the session directory from. */
const exec = { agent: { session: { header: { cwd: "/repo" } } }, signal: undefined };

/** Collect every argv the plugin produced during a run. */
const argvs = (specs) => specs.map((spec) => spec.argv);

test("the plugin registers exactly the six documented tools", () => {
	const { tools } = toolsFor();
	assert.deepEqual([...tools.keys()].sort(), ["git_branch", "git_commit", "git_diff", "git_log", "git_stash", "git_status"]);
});

test("every invocation is an argv array with no shell command string", async () => {
	const { tools, specs } = toolsFor();
	await tools.get("git_status").execute({}, exec);
	await tools.get("git_diff").execute({}, exec);
	await tools.get("git_log").execute({}, exec);
	await tools.get("git_branch").execute({}, exec);
	await tools.get("git_stash").execute({}, exec);

	assert.ok(specs.length >= 5);
	for (const spec of specs) {
		assert.ok(Array.isArray(spec.argv));
		assert.equal(spec.argv[0], "git");
		// The whole security argument rests on this: no field exists through
		// which a shell could reinterpret an argument.
		assert.equal("command" in spec, false);
		assert.equal("shell" in spec, false);
	}
});

test("git_status asks for porcelain v2 with branch headers and NUL records", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_status").execute({}, exec);
	const argv = specs[0].argv;
	assert.ok(argv.includes("--porcelain=v2"));
	assert.ok(argv.includes("--branch"));
	assert.ok(argv.includes("--untracked-files=all"));
	assert.ok(argv.includes("-z"));
	assert.equal(value.ok, true);
	assert.equal(value.branch, "main");
	assert.equal(value.ahead, 1);
});

test("git_status does not request approval", async () => {
	const { tools, approvals } = toolsFor();
	await tools.get("git_status").execute({}, exec);
	assert.deepEqual(approvals, []);
});

test("git_diff runs a numstat pass and, by default, a patch pass", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_diff").execute({}, exec);
	assert.equal(specs.length, 2);
	assert.ok(specs[0].argv.includes("--numstat"));
	assert.ok(specs[1].argv.includes("--no-ext-diff"));
	assert.equal(value.ok, true);
	assert.equal(value.files.length, 1);
});

test("git_diff skips the patch pass when patch is false", async () => {
	const { tools, specs } = toolsFor();
	await tools.get("git_diff").execute({ patch: false }, exec);
	assert.equal(specs.length, 1);
});

test("git_diff scopes the diff with a -- separator and the given paths", async () => {
	const { tools, specs } = toolsFor();
	await tools.get("git_diff").execute({ paths: ["src/a.js"] }, exec);
	const argv = specs[0].argv;
	const separator = argv.indexOf("--");
	assert.ok(separator > 0, "a -- separator must guard the pathspecs");
	assert.deepEqual(argv.slice(separator + 1), ["src/a.js"]);
});

test("git_diff rejects a path that escapes the repository", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_diff").execute({ paths: ["../../etc/passwd"] }, exec);
	assert.equal(value.ok, false);
	// Nothing was executed, so no git process could act on the bad path.
	assert.equal(specs.length, 0);
	assert.match(value.message, /escapes the repository root/);
});

test("git_log uses a NUL/NUL-separated machine format", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_log").execute({}, exec);
	const argv = specs[0].argv;
	assert.ok(argv.includes("-z"));
	assert.ok(argv.some((token) => token.startsWith("--format=%H%x1f%h%x1f%an")));
	assert.equal(value.commits.length, 1);
	assert.equal(value.commits[0].subject, "fix: something");
});

test("git_log rejects a revision beginning with a dash", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_log").execute({ revision: "--upload-pack=touch /tmp/pwned" }, exec);
	assert.equal(value.ok, false);
	assert.equal(specs.length, 0);
});

test("git_commit passes the message as one argv element and requests approval first", async () => {
	const { tools, specs, approvals } = toolsFor();
	const message = 'fix: keep %PATH% and $(whoami) and "quotes"\n\n正文：中文。';
	const value = await tools.get("git_commit").execute({ message }, exec);

	// Approval happened, and happened before the process ran.
	assert.equal(approvals.length, 1);
	assert.equal(approvals[0].toolName, "git_commit");
	assert.match(approvals[0].reason, /create a commit/);

	const commitArgv = argvs(specs).find((argv) => argv.includes("commit"));
	assert.ok(commitArgv, "a commit invocation must have been made");
	assert.equal(commitArgv[commitArgv.indexOf("-m") + 1], message);
	assert.equal(value.ok, true);
	assert.equal(value.commit, "abc1234");
});

test("git_commit stages the requested paths before committing", async () => {
	const { tools, specs, approvals } = toolsFor();
	await tools.get("git_commit").execute({ message: "chore: stage", paths: ["src/a.js", "docs/b.md"] }, exec);
	const order = argvs(specs).map((argv) => subcommandOf(argv));
	assert.deepEqual(order, ["add", "commit", "rev-parse"]);
	const addArgv = argvs(specs)[0];
	assert.deepEqual(addArgv.slice(addArgv.indexOf("--") + 1), ["src/a.js", "docs/b.md"]);
	assert.equal(approvals.length, 1);
});

test("git_commit rejects an empty message without touching the repository", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_commit").execute({ message: "   " }, exec);
	assert.equal(value.ok, false);
	assert.equal(specs.length, 0);
});

test("git_commit fails closed when no approval service is mounted", async () => {
	const { tools, specs } = toolsFor({ noApproval: true });
	await assert.rejects(
		() => tools.get("git_commit").execute({ message: "fix: x" }, exec),
		/needs the harness approval service/,
	);
	// The refusal must happen before any process runs.
	assert.equal(specs.length, 0);
});

test("git_commit refuses when the approval is anything but a one-time grant", async () => {
	const { tools, specs } = toolsFor({ approvalOutcome: "denied" });
	await assert.rejects(() => tools.get("git_commit").execute({ message: "fix: x" }, exec), /was not approved \(denied\)/);
	assert.equal(specs.length, 0);
});

test("git_branch list is read-only and unapproved", async () => {
	const { tools, specs, approvals } = toolsFor();
	const value = await tools.get("git_branch").execute({ action: "list" }, exec);
	assert.deepEqual(approvals, []);
	assert.equal(value.branches.length, 2);
	assert.equal(value.branches[0].current, true);
	// A branch with no upstream must omit the field: the output schema types it
	// as a string, so `null` would fail the harness's own output validation
	// with INVALID_TOOL_OUTPUT and fail an otherwise successful call.
	assert.equal("upstream" in value.branches[1], false);
	assert.equal(value.branches[0].upstream, "origin/main");
	// The listing must use a machine format, not the decorated default.
	assert.ok(specs[0].argv.some((token) => token.startsWith("--format=%(HEAD)")));
});

test("git_branch mutations are approved and use a -- separator", async () => {
	const { tools, specs, approvals } = toolsFor();
	await tools.get("git_branch").execute({ action: "create", name: "feature/x" }, exec);
	assert.equal(approvals.length, 1);
	const createArgv = argvs(specs).find((argv) => argv.includes("branch") && argv.includes("feature/x"));
	assert.ok(createArgv);
	assert.deepEqual(createArgv.slice(createArgv.indexOf("--")), ["--", "feature/x"]);
});

test("git_branch refuses an invalid branch name without running anything", async () => {
	const { tools, specs } = toolsFor();
	const value = await tools.get("git_branch").execute({ action: "create", name: "bad name with spaces" }, exec);
	assert.equal(value.ok, false);
	assert.equal(specs.length, 0);
});

test("git_branch uses -D only when force is explicitly requested", async () => {
	const safe = toolsFor();
	await safe.tools.get("git_branch").execute({ action: "delete", name: "old" }, exec);
	const safeArgv = argvs(safe.specs).find((argv) => argv.includes("branch") && argv.includes("old"));
	assert.ok(safeArgv.includes("-d"));
	assert.equal(safeArgv.includes("-D"), false);

	const forced = toolsFor();
	await forced.tools.get("git_branch").execute({ action: "delete", name: "old", force: true }, exec);
	const forcedArgv = argvs(forced.specs).find((argv) => argv.includes("branch") && argv.includes("old"));
	assert.ok(forcedArgv.includes("-D"));
});

test("git_stash list is read-only and unapproved", async () => {
	const { tools, approvals } = toolsFor();
	const value = await tools.get("git_stash").execute({ action: "list" }, exec);
	assert.deepEqual(approvals, []);
	assert.equal(value.stashes.length, 1);
});

test("git_stash drop is approved because it destroys an entry", async () => {
	const { tools, approvals } = toolsFor();
	await tools.get("git_stash").execute({ action: "drop", ref: "stash@{1}" }, exec);
	assert.equal(approvals.length, 1);
	assert.match(approvals[0].reason, /permanently/);
});

test("no tool can reach a repository-destroying subcommand", async () => {
	const { tools, specs } = toolsFor();
	// Drive every tool through every action so the sweep covers the whole
	// surface rather than only the default path.
	for (const tool of tools.values()) {
		for (const args of [{}, { action: "list" }, { action: "create", name: "x" }, { action: "switch", name: "x" }, { action: "delete", name: "x" }, { patch: false }]) {
			try {
				await tool.execute(args, exec);
			} catch {
				// Approval-less write paths reject; the sweep only needs the specs
				// that were recorded before the rejection.
			}
		}
	}

	const allTokens = argvs(specs).flat();
	const forbidden = [
		"push",
		"fetch",
		"pull",
		"--force",
		"--hard",
		"-fdx",
		"rebase",
		"remote",
		"config",
		"checkout",
		"switch", // appears only as a git subcommand for branches, never as a destroyer
	];
	for (const token of forbidden) {
		if (token === "switch") continue; // `git switch <branch>` is the branch tool's job
		assert.equal(allTokens.includes(token), false, `forbidden git token "${token}" was reachable`);
	}
	// The stash action named `push` is a local save, never a remote push:
	// it must always appear behind the `stash` subcommand.
	for (const argv of argvs(specs)) {
		const subcommand = subcommandOf(argv);
		assert.notEqual(subcommand, "push");
		assert.notEqual(subcommand, "reset");
		assert.notEqual(subcommand, "clean");
	}
});

test("an unsupported action is refused, naming every accepted value", async () => {
	// The action set is enforced in code rather than by an `enum` in the tool
	// schema, because a provider rejects the whole function schema once it
	// contains `enum`. That makes this check the only guard on the set.
	const branch = toolsFor();
	const branchValue = await branch.tools.get("git_branch").execute({ action: "obliterate" }, exec);
	assert.equal(branchValue.ok, false);
	assert.match(branchValue.message, /unsupported action "obliterate"/);
	assert.match(branchValue.message, /list, create, switch, delete/);
	assert.equal(branch.specs.length, 0);

	const stash = toolsFor();
	const stashValue = await stash.tools.get("git_stash").execute({ action: "reflog" }, exec);
	assert.equal(stashValue.ok, false);
	assert.match(stashValue.message, /list, push, pop, apply, drop/);
	assert.equal(stash.specs.length, 0);

	// A non-string reaches the same guard rather than being coerced.
	const typed = toolsFor();
	const typedValue = await typed.tools.get("git_branch").execute({ action: 7 }, exec);
	assert.equal(typedValue.ok, false);
	assert.match(typedValue.message, /must be a string/);
});

test("no tool returns null for a field its schema types as non-null", async () => {
	// The harness validates the returned value against the declared output
	// schema and raises INVALID_TOOL_OUTPUT on a mismatch — after git has
	// already run, so the work succeeds and the turn still fails. `undefined`
	// is fine because the field is then simply absent; `null` is not, and
	// `git_branch` originally sent `upstream: null` for an untracked branch.
	const walk = (node, path) => {
		if (node === null) assert.fail(`${path} is null; omit the field instead`);
		if (Array.isArray(node)) {
			node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
			return;
		}
		if (typeof node === "object") {
			for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
		}
	};
	const cases = [
		["git_status", {}],
		["git_diff", {}],
		["git_log", {}],
		["git_branch", {}],
		["git_commit", { message: "fix: x" }],
		["git_stash", {}],
	];
	for (const [toolName, args] of cases) {
		const tool = toolsFor().tools.get(toolName);
		walk(await tool.execute(args, exec), toolName);
	}
});

test("every tool's render survives its own execute output", async () => {
	// A renderer that reads a field its execute never returned throws inside
	// the harness, which reports it as invalid tool output and fails the turn —
	// after the git command has already succeeded. Driving each tool through
	// execute and on into render is the only cheap way to catch that.
	const cases = [
		["git_status", {}],
		["git_diff", {}],
		["git_diff", { patch: false }],
		["git_log", {}],
		["git_branch", {}],
		["git_commit", { message: "fix: x" }],
		["git_stash", {}],
	];
	for (const [toolName, args] of cases) {
		const tool = toolsFor().tools.get(toolName);
		const value = await tool.execute(args, exec);
		const rendered = tool.output.render(args, value);
		assert.ok(Array.isArray(rendered) && rendered.length > 0, `${toolName} render must return content`);
		assert.equal(typeof rendered[0].text, "string", `${toolName} render must produce text`);
		assert.ok(rendered[0].text.length > 0, `${toolName} render must produce non-empty text`);
	}
});

test("every tool's render survives a failure value", async () => {
	// Failure values carry a different field set from success values, and a
	// renderer that assumes the success shape fails exactly when the user most
	// needs to read the error.
	for (const toolName of ["git_status", "git_diff", "git_log", "git_branch", "git_commit", "git_stash"]) {
		const tool = toolsFor().tools.get(toolName);
		const rendered = tool.output.render({}, { ok: false, exitCode: 128, message: `${toolName}: boom` });
		assert.equal(typeof rendered[0].text, "string");
		assert.ok(rendered[0].text.includes("boom"), `${toolName} must surface the failure message`);
	}
});

test("every tool's render survives a sparse success value", async () => {
	// Everything but `ok` is optional in the declared schema, so a value
	// carrying only `ok` is reachable and must not throw.
	for (const toolName of ["git_status", "git_diff", "git_log", "git_branch", "git_commit", "git_stash"]) {
		const tool = toolsFor().tools.get(toolName);
		const rendered = tool.output.render({}, { ok: true });
		assert.ok(Array.isArray(rendered) && rendered.length > 0, `${toolName} must render a sparse success value`);
		assert.ok(rendered[0].text.length > 0);
	}
});

test("renderStatus writes git's own two-column status codes", () => {
	// Abbreviating the status words by first letter collides: `unmodified` and
	// `unmerged` both start with `u`, so an unstaged edit rendered as `um`,
	// which is not a code git ever prints and reads as noise.
	const text = toolsFor()
		.tools.get("git_status")
		.output.render({}, {
			ok: true,
			branch: "main",
			detached: false,
			oid: "abcdef1234",
			upstream: "",
			ahead: 0,
			behind: 0,
			staged: [{ path: "staged.txt", index: "modified", worktree: "unmodified" }],
			modified: [{ path: "modified.txt", index: "unmodified", worktree: "modified" }],
			conflicted: [{ path: "both.txt", index: "unmerged", worktree: "unmerged" }],
			untracked: ["new.txt"],
			ignored: [],
		})[0].text;

	assert.ok(text.includes("M.  staged.txt"), `a staged edit must render as M then dot:\n${text}`);
	// Two columns, index first: `.` means the index matches HEAD, `M` means the
	// worktree differs from the index.
	assert.ok(text.includes(".M  modified.txt"), `an unstaged edit must render as dot then M:\n${text}`);
	assert.ok(text.includes("UU  both.txt"), `a conflict must render as UU:\n${text}`);
	// An empty upstream must not render the word with nothing after it.
	assert.equal(text.includes("upstream"), false, `an absent upstream must be omitted:\n${text}`);
	assert.ok(text.includes("untracked (1):"), text);
});

test("renderBranches omits the arrow for a branch with no upstream", () => {
	// The tool omits `upstream` for an untracked branch, so the absent case is
	// `undefined`, not `null`. Interpolating it printed the literal word
	// "undefined" after the branch name in a real turn.
	const text = toolsFor()
		.tools.get("git_branch")
		.output.render({}, {
			ok: true,
			action: "list",
			branches: [
				{ current: true, name: "main" },
				{ current: false, name: "feature/x", upstream: "origin/feature/x" },
			],
		})[0].text;
	assert.ok(text.includes("* main"), text);
	assert.ok(text.includes("-> origin/feature/x"), text);
	assert.equal(text.includes("undefined"), false, `an absent upstream must not render literally:\n${text}`);
	assert.equal(text.includes("null"), false, text);
});

test("renderStatus marks a rename with its source", () => {
	const text = toolsFor()
		.tools.get("git_status")
		.output.render({}, {
			ok: true,
			branch: "main",
			staged: [{ path: "new name.js", from: "old name.js", index: "renamed", worktree: "unmodified" }],
		})[0].text;
	assert.ok(text.includes("R."), text);
	assert.ok(text.includes("(from old name.js)"), text);
});
