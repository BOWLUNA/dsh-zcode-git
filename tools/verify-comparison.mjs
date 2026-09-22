#!/usr/bin/env node
/**
 * Check the ZCode comparison table in `README.md`, row by row.
 *
 *   node tools/verify-comparison.mjs
 *
 * The table's whole claim to being honest is that it can be checked rather than
 * believed. A citation like `src/validate.js:167` proves only that a file and a
 * line exist; it does not show that the line does what the row says. "I read the
 * source" is not evidence. This script is: every row that can be reduced to a
 * mechanical claim gets a check here, and the README cites `verify-comparison.mjs
 * row N` instead of a line number.
 *
 * Exit status:
 *
 *   0  every claim holds (including rows that are *supposed* to be gaps)
 *   1  a claim does not hold — the table is overstating something
 *
 * Row 5 is a known defect rather than a claim of superiority, so it is reported
 * as `CONFIRMED-GAP`: the script asserts the defect is *still reproducible*, and
 * the check starts failing the day someone fixes GIT-4 — which is the point. A
 * gap that silently "passes" after a fix would leave the README lying.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTools } from "../index.js";
import { validateBranchName, validateCommitMessage, validateRepoRelativePath, validateRevision, clampInteger } from "../src/validate.js";

const SETTINGS = { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: true };

// ── a recording stand-in for ctx.subprocess ────────────────────
/**
 * Build a context that records every spawn spec and answers with canned output.
 *
 * @param respond - maps the argv to the stdout the command should report.
 * @param options - `noApproval` removes the approval service.
 * @returns the context plus the recorded specs.
 */
function harness(respond, options = {}) {
	const specs = [];
	const ctx = {
		get(name) {
			if (name === "subprocess") {
				return {
					spawn(spec) {
						specs.push(spec);
						const text = respond(spec.argv);
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
				return { request: async () => "allowed-once" };
			}
			return undefined;
		},
	};
	return { ctx, specs };
}

const exec = { agent: { session: { header: { cwd: "/repo" } } }, signal: undefined };
const tool = (ctx, name) => defineTools(ctx, SETTINGS).find((t) => t.name === name);

/** The `git ...` argument list from a recorded spec, with the pins stripped. */
const subcommand = (argv) => {
	let i = 1;
	while (i < argv.length) {
		if (argv[i] === "-c") { i += 2; continue; }
		return argv[i];
	}
	return null;
};

// ── the checks ─────────────────────────────────────────────────
const results = [];
const check = (row, claim, ok, observed) => {
	results.push({ row, claim, ok, observed });
};

// row 1 — an argv array, and the write half behind a fail-closed gate
{
	const { ctx, specs } = harness(() => "");
	const { ctx: noApproval } = harness(() => "", { noApproval: true });

	const status = tool(ctx, "git_status");
	await status.execute({}, exec);
	const spec = specs.at(-1);
	check(1, "git is spawned with an argv array", Array.isArray(spec.argv) && spec.argv[0] === "git",
		`argv[0..1] = ${JSON.stringify(spec.argv.slice(0, 2))}, isArray=${String(Array.isArray(spec.argv))}`);
	check(1, "no shell string is ever built", spec.argv.every((a) => typeof a === "string") && spec.argv.includes("--porcelain=v2"),
		"every element is a distinct argv entry; no quoting layer exists");

	// A commit without an approval service must be REFUSED, not allowed.
	const commit = tool(noApproval, "git_commit");
	let refused = false;
	let why = "";
	try {
		await commit.execute({ message: "x" }, exec);
	} catch (error) {
		refused = true;
		why = String(error.message).slice(0, 60);
	}
	check(1, "approval is fail-closed (no service ⇒ refuse)", refused, refused ? why : "it committed without approval");
}

// row 2 — the strict validators, and where the safety actually comes from
//
// The first version of this check asserted that every validator throws, and
// then that a branch name starting with `-` is rejected. Both were checks of my
// assumptions rather than of the code: the contract is "return an error message
// or null", and a leading dash is *not* rejected on branch names — it does not
// need to be, because the name is placed after `--`. That is worth checking
// directly, since it is the actual property.
{
	const attempts = [
		["validateRevision", "-foo", () => validateRevision("-foo")],
		["validateCommitMessage", "(empty)", () => validateCommitMessage("")],
		["validateRepoRelativePath", "..\\..\\x", () => validateRepoRelativePath("..\\..\\x")],
		["validateRepoRelativePath", "/abs/path", () => validateRepoRelativePath("/abs/path")],
	];
	const accepted = [];
	for (const [name, input, run] of attempts) {
		if (run() === null) accepted.push(`${name}(${input})`);
	}
	check(2, "revisions beginning with `-`, empty messages, and traversal are rejected", accepted.length === 0,
		accepted.length === 0
			? `${String(attempts.length)}/${String(attempts.length)} rejected via a non-null message`
			: `★ wrongly accepted: ${accepted.join(", ")}`);

	// git's own forbidden character set for ref names, which is a different job
	// from the dash rule: a space or `~` is invalid, not dangerous.
	const badNames = ["a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a..b", "a@{b", "/a", "a.", "a.lock", "a//b", "@"];
	const badAccepted = badNames.filter((n) => validateBranchName(n) === null);
	check(2, "git-forbidden ref characters are rejected on branch names", badAccepted.length === 0,
		badAccepted.length === 0 ? `${String(badNames.length)}/${String(badNames.length)} rejected` : `★ accepted: ${badAccepted.join(" ")}`);

	// The real safety property: user-supplied names travel after `--`, so a
	// leading dash is a name rather than an option. That is why the revision
	// validator needs a dash rule and the branch validator does not.
	//
	// `git_branch` runs the mutation and then a `--list` to report the resulting
	// state, so the mutation is not simply the last spec — find it by shape.
	const { ctx, specs } = harness(() => "");
	await tool(ctx, "git_branch").execute({ action: "create", name: "-b" }, exec);
	const mutate = specs.find((s) => s.argv.includes("-b"));
	const argv = mutate?.argv ?? [];
	const dd = argv.indexOf("--");
	const afterDash = dd !== -1 && argv[dd + 1] === "-b";
	check(2, "user-supplied names are placed after `--`, so `-b` is a name not an option", afterDash,
		mutate === undefined ? "★ no command carried the name at all" : `git ${argv.slice(1).join(" ")}`);
}

// row 3 — NUL/unit separators, and which one this plugin uses
{
	const { ctx, specs } = harness((argv) => (subcommand(argv) === "status" ? "# branch.head main\0" : ""));
	await tool(ctx, "git_status").execute({}, exec);
	const statusArgv = specs.at(-1).argv;
	check(3, "`git status` asks for -z", statusArgv.includes("-z"),
		`--porcelain=v2 ${statusArgv.includes("-z") ? "-z" : "(no -z)"} present`);

	const { ctx: logCtx, specs: logSpecs } = harness(() => "");
	await tool(logCtx, "git_log").execute({}, exec);
	const format = logSpecs.at(-1).argv.find((a) => a.startsWith("--format=")) ?? "";
	const usesUnit = format.includes("%x1f");
	const usesNul = format.includes("%x00");
	check(3, "log fields are separated by %x1f, and ZCode's %x00 is stricter", usesUnit && usesNul === false,
		`--format=${format.replace("--format=", "")} (ZCode uses %x00 — this row is a gap, not a win)`);
}

// row 4 — the pinned configuration really reaches git
{
	const { ctx, specs } = harness(() => "");
	await tool(ctx, "git_status").execute({}, exec);
	const argv = specs.at(-1).argv;
	const pins = [];
	for (let i = 0; i < argv.length - 1; i += 1) if (argv[i] === "-c") pins.push(argv[i + 1]);
	const named = ["color.ui=false", "core.pager=cat", "core.quotepath=false", "diff.external=", "status.relativePaths=false", "log.showSignature=false"];
	const missing = named.filter((n) => pins.includes(n) === false);
	check(4, "exactly 10 `-c` overrides reach git", pins.length === 10, `${String(pins.length)} pins: ${pins.join(" ")}`);
	check(4, "the named keys are among them", missing.length === 0, missing.length === 0 ? "all six present" : `missing ${missing.join(", ")}`);
}

// row 5 — the sub-directory path base: a CONFIRMED GAP, not a win
{
	const lab = mkdtempSync(join(tmpdir(), "verify-comparison-"));
	try {
		const repo = join(lab, "repo");
		const sub = join(repo, "sub", "nested");
		mkdirSync(sub, { recursive: true });
		const gitEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "v", GIT_AUTHOR_EMAIL: "v@x.invalid",
			GIT_COMMITTER_NAME: "v", GIT_COMMITTER_EMAIL: "v@x.invalid",
		};
		const run = (args, cwd) => new Promise((r) => {
			const c = spawn("git", args, { cwd, env: gitEnv, windowsHide: true, stdio: "ignore" });
			c.once("close", (code) => r(code));
		});
		writeFileSync(join(repo, "root.txt"), "a\n");
		writeFileSync(join(sub, "inner.txt"), "b\n");
		await run(["init", "-q", "-b", "main"], repo);
		await run(["add", "-A"], repo);
		await run(["commit", "-q", "-m", "seed"], repo);
		writeFileSync(join(repo, "root.txt"), "a2\n");
		writeFileSync(join(sub, "inner.txt"), "b2\n");

		// A seam that really spawns git, so the path base git actually reports is
		// what gets checked — this row is about git's behaviour, not a mock's.
		const realCtx = {
			get: (name) => (name === "subprocess"
				? {
					spawn(spec) {
						const [file, ...args] = spec.argv;
						const child = spawn(file, args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
						const out = [];
						child.stdout.on("data", (d) => out.push(d));
						return {
							done: new Promise((res) => child.once("close", (exitCode, signal) => res({ exitCode, signal }))),
							collected: {
								stdout: { readFrom: () => ({ text: Buffer.concat(out).toString("utf8"), nextOffset: 0, lossy: false }) },
								stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
							},
						};
					},
				}
				: undefined),
		};
		const inSubdir = { agent: { session: { header: { cwd: sub } } }, signal: undefined };
		const status = await tool(realCtx, "git_status").execute({}, inSubdir);
		const handed = status.modified.map((m) => m.path);
		const fedBack = await tool(realCtx, "git_diff").execute({ paths: handed }, inSubdir);

		const looksLikeRepoRelative = handed.includes("sub/nested/inner.txt");
		const silentlyEmpty = fedBack.ok === true && fedBack.files.length === 0 && fedBack.message === undefined;
		check(5, "KNOWN GAP still reproduces: handing the paths back returns nothing",
			looksLikeRepoRelative && silentlyEmpty,
			`paths=${JSON.stringify(handed)} → ok=${String(fedBack.ok)} files=${JSON.stringify(fedBack.files.length)} message=${JSON.stringify(fedBack.message ?? null)}`);
	} finally {
		rmSync(lab, { recursive: true, force: true });
	}
}

// row 6 — truncation is reported instead of silent
{
	const rawPatch = Array.from({ length: 900 }, (_, i) => `+line ${String(i)}`).join("\n");
	const { ctx } = harness((argv) => (argv.includes("--numstat") ? "10\t2\tsrc/a.js\0" : rawPatch));
	const diff = await tool(ctx, "git_diff").execute({ maxLines: 100 }, exec);
	check(6, "an over-long patch is clamped", diff.patch.split("\n").length <= 100,
		`900-line patch → ${String(diff.patch.split("\n").length)} lines`);
	check(6, "and the clamp is reported, not silent", diff.truncated === true,
		`truncated=${String(diff.truncated)}`);
	check(6, "maxDiffLines is clamped to the documented range",
		clampInteger(1, 500, 10, 5000) === 10 && clampInteger(99999, 500, 10, 5000) === 5000,
		`clampInteger(1)=10, clampInteger(99999)=5000`);
}

// ── report ─────────────────────────────────────────────────────
console.log("verify-comparison — the README's ZCode table, checked row by row");
console.log("");
let failed = 0;
let lastRow = null;
for (const r of results) {
	if (r.row !== lastRow) {
		console.log(`  row ${String(r.row)}`);
		lastRow = r.row;
	}
	if (r.ok === false) failed += 1;
	const tag = r.row === 5 ? (r.ok ? "GAP REPRODUCES" : "★ GAP GONE") : r.ok ? "PASS" : "FAIL";
	console.log(`    ${tag.padEnd(15)} ${r.claim}`);
	console.log(`    ${" ".repeat(15)} ${r.observed}`);
}
console.log("");
if (failed === 0) {
	console.log(`✓ all ${String(results.length)} checks hold`);
	process.exit(0);
}
console.error(`✗ ${String(failed)} of ${String(results.length)} checks failed — the table overstates something`);
process.exit(1);
