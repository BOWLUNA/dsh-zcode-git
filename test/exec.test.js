import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkdir, runGit } from "../src/exec.js";

/**
 * Build a context whose subprocess service records the spec it was handed.
 *
 * @param options - `exitCode`, `stdout`, `stderr`, `lossy` shape the fake
 *   process result; `spawnThrows` and `noService` exercise the failure paths.
 * @returns the recording context plus the captured specs.
 */
function mockContext(options = {}) {
	const specs = [];
	const service = {
		spawn(spec) {
			specs.push(spec);
			if (options.spawnThrows === true) throw new Error("spawn refused");
			return {
				done: options.doneRejects === true
					? Promise.reject(new Error("provider lost the process"))
					: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: options.signal ?? null }),
				collected: {
					stdout: {
						readFrom: () => ({ text: options.stdout ?? "", nextOffset: (options.stdout ?? "").length, lossy: options.lossy === true }),
					},
					stderr: {
						readFrom: () => ({ text: options.stderr ?? "", nextOffset: (options.stderr ?? "").length, lossy: false }),
					},
				},
			};
		},
	};
	return {
		specs,
		ctx: {
			get: (name) => (name === "subprocess" && options.noService !== true ? service : undefined),
		},
	};
}

/** A minimal stand-in for the tool execution context. */
const exec = { agent: { session: { header: { cwd: "/repo" } } }, signal: undefined };

test("runGit builds an argv array and never a shell command string", async () => {
	const { ctx, specs } = mockContext();
	await runGit(ctx, ["status", "--porcelain=v2"], { cwd: "/repo" });

	assert.equal(specs.length, 1);
	const spec = specs[0];
	assert.ok(Array.isArray(spec.argv), "argv must be an array");
	assert.equal(spec.argv[0], "git");
	assert.ok(spec.argv.includes("status"));
	assert.ok(spec.argv.includes("--porcelain=v2"));
	// The decisive assertion: there is no command line anywhere in the spec, so
	// no shell can ever interpret an argument.
	assert.equal("command" in spec, false);
	assert.equal("shell" in spec, false);
});

test("runGit pins the configuration that reshapes parsed output", async () => {
	const { ctx, specs } = mockContext();
	await runGit(ctx, ["log"], { cwd: "/repo" });

	const argv = specs[0].argv;
	// Each of these, left at the user's setting, changes the bytes this plugin
	// parses — which is the class of bug the plugin exists to prevent.
	for (const pinned of [
		"color.ui=false",
		"core.pager=cat",
		"core.quotepath=false",
		"status.relativePaths=false",
		"log.showSignature=false",
		"diff.external=",
	]) {
		assert.ok(argv.includes(pinned), `expected ${pinned} to be pinned`);
	}
	// Pinned config must precede the subcommand, which is where git reads `-c`.
	assert.ok(argv.indexOf("-c") < argv.indexOf("log"));
});

test("runGit hardens the child environment against an interactive prompt", async () => {
	const { ctx, specs } = mockContext();
	await runGit(ctx, ["status"], { cwd: "/repo" });

	// Without GIT_TERMINAL_PROMPT=0 a credential-needing command blocks on a
	// prompt nobody can answer, and the only symptom is a timeout.
	assert.equal(specs[0].env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(specs[0].env.GIT_OPTIONAL_LOCKS, "0");
	assert.equal(specs[0].env.GIT_PAGER, "cat");
});

test("a commit message reaches git byte-for-byte", async () => {
	const { ctx, specs } = mockContext();
	// Every shape a shell would mangle: percent-expansion, command
	// substitution, quoting, CJK, and an embedded newline.
	const message = 'fix: keep %PATH% and $(whoami) and "quotes" and `ticks`\n\n正文：中文提交信息。';
	await runGit(ctx, ["commit", "-m", message], { cwd: "/repo" });

	const argv = specs[0].argv;
	// One argv element, unmodified — not a quoted fragment of a command line.
	assert.ok(argv.includes(message), "the message must appear as a single unmodified argv element");
	assert.equal(argv[argv.indexOf("-m") + 1], message);
});

test("runGit requests collected stdout and stderr with a spill ceiling", async () => {
	const { ctx, specs } = mockContext();
	await runGit(ctx, ["diff"], { cwd: "/repo" });

	const stdio = specs[0].stdio;
	assert.equal(stdio.stdin, "ignore");
	assert.ok(typeof stdio.stdout.maxBytes === "number" && stdio.stdout.maxBytes > 0);
	assert.ok(typeof stdio.stderr.maxBytes === "number" && stdio.stderr.maxBytes > 0);
	// The grace period is mandatory in the spec validator.
	assert.ok(typeof specs[0].graceMs === "number" && specs[0].graceMs > 0);
});

test("runGit passes stdin through only when a body is supplied", async () => {
	const { ctx, specs } = mockContext();
	await runGit(ctx, ["hash-object"], { cwd: "/repo", stdin: "body" });
	assert.deepEqual(specs[0].stdio.stdin, { data: "body" });
});

test("runGit reports a missing subprocess service instead of throwing", async () => {
	const { ctx } = mockContext({ noService: true });
	const result = await runGit(ctx, ["status"], { cwd: "/repo" });
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, null);
	assert.match(result.message, /subprocess service/);
});

test("runGit reports a spawn failure as an actionable message", async () => {
	const { ctx } = mockContext({ spawnThrows: true });
	const result = await runGit(ctx, ["status"], { cwd: "/repo" });
	assert.equal(result.ok, false);
	assert.match(result.message, /is git installed and on PATH/);
});

test("runGit surfaces a provider rejection rather than a fake exit code", async () => {
	const { ctx } = mockContext({ doneRejects: true });
	const result = await runGit(ctx, ["status"], { cwd: "/repo" });
	assert.equal(result.ok, false);
	// No exit code exists, so reporting one would be a fabricated fact.
	assert.equal(result.exitCode, null);
	assert.match(result.message, /could not be run to completion/);
});

test("runGit resolves a non-zero exit so callers can render it", async () => {
	const { ctx } = mockContext({ exitCode: 128, stderr: "fatal: not a git repository" });
	const result = await runGit(ctx, ["status"], { cwd: "/repo" });
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 128);
	assert.equal(result.stderr, "fatal: not a git repository");
});

test("runGit marks a stream as truncated when the seam reports loss", async () => {
	const { ctx } = mockContext({ stdout: "partial", lossy: true });
	const result = await runGit(ctx, ["diff"], { cwd: "/repo" });
	assert.equal(result.truncated, true);
});

test("resolveWorkdir falls back to the session directory", () => {
	assert.equal(resolveWorkdir(undefined, exec), "/repo");
	assert.equal(resolveWorkdir("", exec), "/repo");
	// A relative value resolves against the session directory, not the harness
	// process cwd, which differs between desktop and CLI hosts.
	assert.match(resolveWorkdir("sub/dir", exec), /repo[\\/]sub[\\/]dir$/);
});

test("resolveWorkdir honours an absolute path", () => {
	assert.equal(resolveWorkdir("/elsewhere/repo", exec), "/elsewhere/repo");
	if (process.platform === "win32") {
		assert.equal(resolveWorkdir("D:\\other\\repo", exec), "D:\\other\\repo");
	}
});

test("resolveWorkdir tolerates a missing session cwd", () => {
	const bare = { agent: { session: { header: {} } } };
	assert.equal(typeof resolveWorkdir(undefined, bare), "string");
	assert.ok(resolveWorkdir(undefined, bare).length > 0);
});
