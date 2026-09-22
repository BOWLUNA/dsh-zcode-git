#!/usr/bin/env node
/**
 * Measure the three things `docs/MEASUREMENTS.md` lists as gaps, plus the
 * argv-versus-shell contrast the plugin's whole design rests on.
 *
 *   node tools/measure.mjs                       # defaults
 *   node tools/measure.mjs --large-files 3000 --concurrency 8 --big-mb 10
 *   node tools/measure.mjs --only spill          # one section
 *   node tools/measure.mjs --json                # machine-readable
 *
 * ## What is real here, and what is a stand-in
 *
 * **Real**: the plugin's own code path — `defineTools` → each tool's `execute`
 * → `runGit`; the `git` binary; every OS process; the abort/grace/kill ladder;
 * the file system; the clock.
 *
 * **A stand-in**: the `ctx.subprocess` service. The production implementation is
 * `@deepseek-ai/dsh-subprocess-local`, a cordis service that cannot be
 * constructed outside the harness (it wants node-pty and the win32 bindings).
 * This file therefore implements the *documented seam* itself: an argv array
 * (never a command string), `cwd`, `env`, a `stdio` spec of
 * `{maxBytes, spill:{maxBytes}}` per stream, `graceMs`, and an abort signal;
 * returning `{done, collected:{stdout:{readFrom}, stderr:{readFrom}}}`.
 *
 * That distinction is stated again in every number this prints, because a
 * measurement is only worth what its provenance is worth. It means: **a claim
 * about the plugin's behaviour is measured; a claim about the production
 * subprocess service is not.** Where the two differ the harness wins.
 *
 * ## Sections
 *
 *   large   `git_status` over thousands of changed files
 *   spill   a diff larger than the 8 MiB per-stream ceiling
 *   conc    parallel `git_status` calls against the serial baseline
 *   reap    a timeout, then whether the `git` child is actually gone
 *   argv    the same hostile message through an argv array and through a shell
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync, writeSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTools } from "../index.js";
import { runGit } from "../src/exec.js";

// ── arguments ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const LARGE_FILES = Number(flag("large-files", 3000));
const CONCURRENCY = Number(flag("concurrency", 8));
const BIG_MB = Number(flag("big-mb", 10));
const ONLY = flag("only", null);
const AS_JSON = argv.includes("--json");

const wants = (name) => ONLY === null || ONLY === name;

/** Default plugin settings; `timeoutMs` is overridden per section. */
const settings = (over = {}) => ({
	timeoutMs: 30_000,
	maxDiffLines: 500,
	maxLogEntries: 50,
	requireApprovalForWrites: true,
	...over,
});

// ── a faithful implementation of the ctx.subprocess seam ───────
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_SPILL_BYTES = 64 * 1024 * 1024;

/**
 * Build a `ctx.subprocess` stand-in that really spawns processes.
 *
 * @param options - `spillDir` is where an overflowing stream is written.
 * @returns the service, plus the pids it started.
 */
function localSubprocess(options = {}) {
	const pids = [];
	const children = new Set();

	/** Collect a stream, spilling past `maxBytes` exactly as the seam specifies. */
	function collector(stream, spec) {
		const maxBytes = spec?.maxBytes ?? MAX_STREAM_BYTES;
		const spillMax = spec?.spill?.maxBytes ?? MAX_SPILL_BYTES;
		const chunks = [];
		let kept = 0;
		let lossy = false;
		let spillFd = null;
		let spillPath = null;
		let spilled = 0;

		stream.on("data", (buf) => {
			if (kept + buf.length <= maxBytes) {
				chunks.push(buf);
				kept += buf.length;
				return;
			}
			const room = Math.max(0, maxBytes - kept);
			if (room > 0) {
				chunks.push(buf.subarray(0, room));
				kept += room;
			}
			lossy = true;
			const rest = buf.subarray(room);
			if (spilled + rest.length > spillMax) return;
			if (spillFd === null) {
				spillPath = join(options.spillDir ?? tmpdir(), `spill-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.txt`);
				spillFd = openSync(spillPath, "w");
			}
			writeSync(spillFd, rest);
			spilled += rest.length;
		});

		return {
			read(offset = 0) {
				const text = Buffer.concat(chunks).subarray(offset).toString("utf8");
				return { text, nextOffset: kept, lossy, spillPath: spillPath ?? undefined };
			},
			close() {
				if (spillFd !== null) closeSync(spillFd);
			},
			/** What the ceiling actually did, for reporting. */
			facts() {
				return { kept, spilled, spillPath, lossy };
			},
		};
	}

	return {
		pids,
		children,
		/** Per-stream facts from the most recent spawn, for reporting. */
		lastStreams: null,
		/** Raw argv of the most recent spawn, for reporting. */
		lastArgv: null,
		spawn(spec) {
			this.lastArgv = spec.argv;
			const [file, ...args] = spec.argv;
			const child = spawn(file, args, {
				cwd: spec.cwd,
				env: spec.env ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			pids.push(child.pid);
			children.add(child);

			const out = collector(child.stdout, spec.stdio?.stdout);
			const err = collector(child.stderr, spec.stdio?.stderr);

			const stdin = spec.stdio?.stdin;
			if (stdin !== undefined && stdin !== "ignore" && typeof stdin === "object") {
				child.stdin.end(stdin.data ?? "");
			} else {
				child.stdin.end();
			}

			// Terminate on abort, and escalate only after the grace window —
			// the same ladder runGit expects the seam to own.
			let killTimer = null;
			const onAbort = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}, spec.graceMs ?? 3000);
			};
			if (spec.signal !== undefined) {
				if (spec.signal.aborted) onAbort();
				else spec.signal.addEventListener("abort", onAbort, { once: true });
			}

			const done = new Promise((resolve, reject) => {
				child.once("error", (e) => {
					clearTimeout(killTimer);
					out.close();
					err.close();
					reject(e);
				});
				child.once("close", (exitCode, signal) => {
					clearTimeout(killTimer);
					// Captured here rather than on demand, because the plugin never
					// asks for these facts itself.
					this.lastStreams = { stdout: out.facts(), stderr: err.facts() };
					out.close();
					err.close();
					resolve({ exitCode, signal });
				});
			});

			return {
				done,
				collected: {
					stdout: { readFrom: (offset) => out.read(offset) },
					stderr: { readFrom: (offset) => err.read(offset) },
				},
				facts: () => {
					const f = { stdout: out.facts(), stderr: err.facts() };
					this.lastStreams = f;
					return f;
				},
			};
		},
	};
}

/**
 * The plugin context shape `defineTools` needs.
 *
 * The approval service returns `"allowed-once"`, which is the only decision
 * `requireApproval` accepts — so the measurements exercise the real gate rather
 * than switching it off through config.
 */
const pluginCtx = (service) => ({
	get: (name) => {
		if (name === "subprocess") return service;
		if (name === "approval") return { request: async () => "allowed-once" };
		return undefined;
	},
});

/** The tool execution context shape the tools read. */
const execCtx = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: undefined });

const toolNamed = (ctx, cfg, name) => {
	const found = defineTools(ctx, cfg).find((t) => t.name === name);
	assert.ok(found !== undefined, `no tool named ${name}`);
	return found;
};

// ── helpers ────────────────────────────────────────────────────
const run = (cmd, args, opts = {}) =>
	new Promise((resolve) => {
		const child = spawn(cmd, args, { ...opts, windowsHide: true });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += String(d)));
		child.stderr.on("data", (d) => (err += String(d)));
		child.once("close", (code) => resolve({ code, out, err }));
	});

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "measure",
	GIT_AUTHOR_EMAIL: "measure@example.invalid",
	GIT_COMMITTER_NAME: "measure",
	GIT_COMMITTER_EMAIL: "measure@example.invalid",
};

/** True while the pid is still visible to the OS. */
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const results = {};

function report(section, payload) {
	results[section] = payload;
	if (AS_JSON) return;
	console.log(`\n── ${section} ─────────────────────────────────────────`);
	for (const [k, v] of Object.entries(payload)) console.log(`   ${k.padEnd(26)} ${String(v)}`);
}

// ── the measurements ───────────────────────────────────────────
const LAB = await mkdtemp(join(tmpdir(), "dsh-git-measure-"));
console.log(`measure lab: ${LAB}`);
console.log(`node ${process.version} · platform ${process.platform}`);

try {
	// ── large ────────────────────────────────────────────────────
	if (wants("large")) {
		const repo = join(LAB, "large");
		mkdirSync(repo, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });

		for (let i = 0; i < LARGE_FILES; i += 1) {
			const dir = join(repo, `d${String(Math.floor(i / 200))}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `f${String(i)}.txt`), `original ${String(i)}\n`);
		}
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed"], { cwd: repo, env: gitEnv });
		for (let i = 0; i < LARGE_FILES; i += 1) {
			writeFileSync(join(repo, `d${String(Math.floor(i / 200))}`, `f${String(i)}.txt`), `changed ${String(i)}\n`);
		}

		const service = localSubprocess({ spillDir: LAB });
		const cfg = settings();
		const ctx = pluginCtx(service);
		const tool = toolNamed(ctx, cfg, "git_status");

		const started = Date.now();
		const value = await tool.execute({}, execCtx(repo));
		const elapsed = Date.now() - started;

		const listed = (value.modified?.length ?? 0);
		const rendered = tool.output.render({}, value)[0].text;

		report("large", {
			"changed files asked for": LARGE_FILES,
			"modified the tool reported": listed,
			"wall time (ms)": elapsed,
			"raw git stdout bytes": service.lastStreams?.stdout.kept ?? 0,
			"stream hit the ceiling (lossy)": service.lastStreams?.stdout.lossy ?? false,
			"rendered text bytes": Buffer.byteLength(rendered, "utf8"),
			"tool reported truncated": value.truncated ?? false,
			"git subprocesses spawned": service.pids.length,
			"argv the tool built": (service.lastArgv ?? []).slice(-4).join(" "),
		});
	}

	// ── spill ────────────────────────────────────────────────────
	if (wants("spill")) {
		const repo = join(LAB, "spill");
		mkdirSync(repo, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });

		// One file whose diff exceeds the seam's 8 MiB per-stream ceiling.
		const line = (tag, i) => `${tag} ${String(i).padStart(7, "0")} ${"x".repeat(40)}\n`;
		const lines = Math.ceil((BIG_MB * 1024 * 1024) / 50);
		const before = join(LAB, "before.txt");
		const after = join(LAB, "after.txt");
		const fdBefore = openSync(before, "w");
		const fdAfter = openSync(after, "w");
		for (let i = 0; i < lines; i += 1) {
			writeSync(fdBefore, line("old", i));
			writeSync(fdAfter, line("new", i));
		}
		closeSync(fdBefore);
		closeSync(fdAfter);
		writeFileSync(join(repo, "big.txt"), readFileSync(before));
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed big"], { cwd: repo, env: gitEnv });
		writeFileSync(join(repo, "big.txt"), readFileSync(after));

		const diffStat = await run("git", ["diff", "--numstat"], { cwd: repo, env: gitEnv });
		const patchBytes = (await run("git", ["diff"], { cwd: repo, env: gitEnv })).out.length;

		const service = localSubprocess({ spillDir: LAB });
		const cfg = settings();
		const ctx = pluginCtx(service);
		const tool = toolNamed(ctx, cfg, "git_diff");

		const started = Date.now();
		const value = await tool.execute({ maxLines: 5000 }, execCtx(repo));
		const elapsed = Date.now() - started;
		const rendered = tool.output.render({}, value)[0].text;

		report("spill", {
			"target stream ceiling (MiB)": MAX_STREAM_BYTES / 1024 / 1024,
			"generated patch bytes": patchBytes,
			"numstat": (diffStat.out.trim().split("\n")[0] ?? "").slice(0, 40),
			"wall time (ms)": elapsed,
			"tool ok": value.ok,
			"tool reported truncated": value.truncated ?? false,
			"tool returned patch bytes": Buffer.byteLength(value.patch ?? "", "utf8"),
			"rendered bytes": Buffer.byteLength(rendered, "utf8"),
			"seam kept bytes": service.lastStreams?.stdout.kept ?? 0,
			"seam tripped (lossy)": service.lastStreams?.stdout.lossy ?? false,
			"bytes spilled to disk": service.lastStreams?.stdout.spilled ?? 0,
			"spill path handed to the model": value.spillPath !== undefined ? "yes" : "no",
		});
	}

	// ── conc ─────────────────────────────────────────────────────
	if (wants("conc")) {
		const repo = join(LAB, "conc");
		mkdirSync(repo, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
		for (let i = 0; i < 400; i += 1) {
			writeFileSync(join(repo, `c${String(i)}.txt`), `v${String(i)}\n`);
		}
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed conc"], { cwd: repo, env: gitEnv });

		const service = localSubprocess({ spillDir: LAB });
		const cfg = settings();
		const ctx = pluginCtx(service);
		const tool = toolNamed(ctx, cfg, "git_status");
		assert.equal(tool.isConcurrencySafe(), true, "git_status must declare itself concurrency-safe");

		const serialStart = Date.now();
		const serial = [];
		for (let i = 0; i < CONCURRENCY; i += 1) serial.push(await tool.execute({}, execCtx(repo)));
		const serialMs = Date.now() - serialStart;

		const parallelStart = Date.now();
		const parallel = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => tool.execute({}, execCtx(repo))),
		);
		const parallelMs = Date.now() - parallelStart;

		const hashes = parallel.map((v) => sha(JSON.stringify(v)));
		const serialHash = sha(JSON.stringify(serial[0]));
		const identical = hashes.every((h) => h === serialHash);

		report("conc", {
			"parallel calls": CONCURRENCY,
			"declared concurrency-safe": tool.isConcurrencySafe(),
			"serial wall (ms)": serialMs,
			"parallel wall (ms)": parallelMs,
			"every parallel result == serial": identical,
			"distinct result hashes": new Set(hashes).size,
			"distinct subprocess pids": new Set(service.pids).size,
		});
	}

	// ── reap ─────────────────────────────────────────────────────
	if (wants("reap")) {
		const repo = join(LAB, "reap");
		mkdirSync(repo, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
		for (let i = 0; i < 500; i += 1) {
			writeFileSync(join(repo, `r${String(i)}.txt`), `r${String(i)}\n`);
		}
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed reap"], { cwd: repo, env: gitEnv });

		const service = localSubprocess({ spillDir: LAB });
		// A deadline short enough to fire while git is still starting. The repo
		// only has to be big enough that git is not already finished at 1 ms —
		// which is every repo, so this stays small on purpose. (It was 5000 files
		// first, which cost minutes on Windows for no extra signal.)
		const cfg = settings({ timeoutMs: 1 });
		const ctx = pluginCtx(service);

		const started = Date.now();
		const result = await runGit(ctx, ["log", "--oneline"], {
			cwd: repo,
			timeoutMs: cfg.timeoutMs,
		});
		const returnedMs = Date.now() - started;
		const pid = service.pids[0];

		let goneAfterMs = null;
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (pidAlive(pid) === false) {
				goneAfterMs = Date.now() - started;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}

		report("reap", {
			"timeoutMs used": cfg.timeoutMs,
			"child pid": pid,
			"runGit ok": result.ok,
			"runGit timedOut": result.timedOut,
			"exitCode / signal": `${String(result.exitCode)} / ${String(result.signal)}`,
			"runGit returned after (ms)": returnedMs,
			"child gone after (ms)": goneAfterMs === null ? "STILL ALIVE after 10s" : goneAfterMs,
			"reaped": goneAfterMs !== null,
			"message": (result.message ?? "").slice(0, 70),
		});
	}

	// ── argv ─────────────────────────────────────────────────────
	if (wants("argv")) {
		const repo = join(LAB, "argv");
		mkdirSync(repo, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
		writeFileSync(join(repo, "a.txt"), "one\n");
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed argv"], { cwd: repo, env: gitEnv });

		// A message a shell would mangle: cmd.exe expands %VAR%, sh expands
		// $(...) and backticks, and a newline ends the command outright.
		const hostile = [
			"subject with %PATH% and $(echo pwned) and `id`",
			"",
			"body line with \"double\" and 'single' quotes",
			"trailing  spaces  kept",
		].join("\n");

		// (a) through the plugin: argv array, no shell.
		const service = localSubprocess({ spillDir: LAB });
		const cfg = settings();
		const ctx = pluginCtx(service);
		const commitTool = toolNamed(ctx, cfg, "git_commit");
		writeFileSync(join(repo, "b.txt"), "two\n");
		await run("git", ["add", "-A"], { cwd: repo, env: gitEnv });

		const committed = await commitTool.execute({ message: hostile }, execCtx(repo));
		const readBack = await run("git", ["log", "-1", "--format=%B"], { cwd: repo, env: gitEnv });
		const trimEnd = (s) => s.replace(/\n+$/, "");
		const argvGot = trimEnd(readBack.out);
		const argvRoundTrips = argvGot === trimEnd(hostile);

		// (b) the same message through a shell-built command line, which is what
		// this plugin exists to avoid. Written the way a naive tool would be.
		const repo2 = join(LAB, "argv-shell");
		mkdirSync(repo2, { recursive: true });
		await run("git", ["init", "-q", "-b", "main"], { cwd: repo2, env: gitEnv });
		writeFileSync(join(repo2, "a.txt"), "one\n");
		await run("git", ["add", "-A"], { cwd: repo2, env: gitEnv });
		await run("git", ["commit", "-q", "-m", "seed"], { cwd: repo2, env: gitEnv });
		writeFileSync(join(repo2, "b.txt"), "two\n");
		await run("git", ["add", "-A"], { cwd: repo2, env: gitEnv });
		const naive = await run("bash", ["-c", `git commit -m "${hostile}"`], { cwd: repo2, env: gitEnv });
		const readBack2 = await run("git", ["log", "-1", "--format=%B"], { cwd: repo2, env: gitEnv });
		const shellGot = trimEnd(readBack2.out);
		const shellRoundTrips = shellGot === trimEnd(hostile);

		report("argv", {
			"message bytes sent": Buffer.byteLength(hostile, "utf8"),
			"[argv] commit ok": committed.ok,
			"[argv] bytes git received": Buffer.byteLength(argvGot, "utf8"),
			"[argv] round-trips byte-for-byte": argvRoundTrips,
			"[argv] sha256 of received": sha(argvGot),
			"[argv] sha256 of sent": sha(trimEnd(hostile)),
			"[shell] exit code": naive.code,
			"[shell] bytes git received": Buffer.byteLength(shellGot, "utf8"),
			"[shell] round-trips byte-for-byte": shellRoundTrips,
			"[shell] sha256 of received": sha(shellGot),
			"[shell] first line received": (shellGot.split("\n")[0] ?? "").slice(0, 80),
			"[shell] line count received": shellGot.split("\n").length,
			"[shell] $(echo pwned) executed": hostile.includes("$(echo pwned)") && shellGot.includes("$(echo pwned)") === false,
			"[shell] `id` executed": hostile.includes("`id`") && shellGot.includes("`id`") === false,
		});
	}
} finally {
	rmSync(LAB, { recursive: true, force: true });
	console.log(`\nlab removed: ${LAB}  (exists now: ${String(existsSync(LAB))})`);
	if (AS_JSON) console.log(JSON.stringify(results, null, 2));
}
