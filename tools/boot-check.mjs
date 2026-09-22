#!/usr/bin/env node
/**
 * Boot check — does the plugin actually install and start?
 *
 *   node tools/boot-check.mjs --port 31870
 *
 * ## Why this exists, and why `--dump-config` is not a substitute
 *
 * `--dump-config` composes configuration; it does **not** apply plugins. A patch
 * row whose `name` has drifted from the package name dumps a clean tree — exit
 * 0, empty stderr, row still listed — while a real boot dies with
 * ERR_MODULE_NOT_FOUND. Measured on this repository: the composed tree is
 * identical whether or not the row resolves, so a dump can never see it. The
 * row's package is resolved against the profile *at boot*, so assertion C is
 * the only one that can catch that class.
 *
 * Same story for `tool "git_status" is already registered` — a registration
 * conflict, also invisible to a dump.
 *
 * ## Why Node and not bash
 *
 * A bash guard can only run on Linux: Git Bash rewrites POSIX paths handed to a
 * native node process (`/d/a/repo` becomes `D:\d\a\repo`). A Node guard has no
 * shell in the path, so it covers Windows too. "Our implementation cannot" is
 * not the same claim as "the platform cannot".
 *
 * ## Assertions
 *
 *   A  `dsh plugin --profile web add <repo>` returns 0
 *   B  `cordis.patch.yml`'s row `name` equals `package.json`'s `name`
 *   C  `--profile web --port <N> --no-open` leaves the port answering **and it
 *      is still answering with the process alive `--settle` ms later**
 *   D  stderr is empty at the moment the port starts answering
 *
 * C is asserted on the socket, never on a printed banner: dsh `0.1.5-rc.2`
 * boots with completely empty stdout while `0.1.6-alpha.2` prints
 * `dsh web: http://…`, and both lines are supported. An assertion on the
 * banner is red on one supported line for a difference in wording.
 *
 * The "and stays up" half of C is not belt and braces — a single connect
 * reports a broken plugin as healthy, with a measured timeline showing why.
 *
 * Exit status, deliberately three-valued so a red never leaves you guessing
 * which of the two things broke:
 *
 *   0  the plugin installed, mounted, and served
 *   1  an assertion failed — the plugin is at fault, and the failed one is named
 *   2  the environment is missing something (harness or pnpm) — **the plugin is
 *      not at fault**
 *
 * ## Harness discovery
 *
 * Never assume `dsh` is on PATH: a development box has a machine-wide install,
 * CI has a `node_modules` one. In order:
 *
 *   1. `--dsh-bin <path>`        explicit, wins over everything
 *   2. `$DSH_INSTALL`            the supported way to point at a harness
 *   3. `<repo>/node_modules/@deepseek-ai/dsh`
 *   4. `dsh` on PATH
 *   5. nothing                   exit 2, with the copy-pasteable recipe
 *
 * ## Options
 *
 *   --port <n>      port to bind                (default 31870)
 *   --timeout <ms>  how long to wait for C      (default 60000)
 *   --settle <ms>   how long C must keep holding (default 2000)
 *   --home <dir>    throwaway DSH_HOME          (default: a fresh mkdtemp)
 *   --dsh-bin <p>   harness entry point         (see above)
 *   --profile <n>   profile to use              (default web)
 *   --quiet         only print the verdict
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ── arguments ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag("port") ?? 31870);
const TIMEOUT = Number(flag("timeout") ?? 60_000);
const SETTLE = Number(flag("settle") ?? 2000);
const PROFILE = flag("profile") ?? "web";
const DSH_BIN = flag("dsh-bin");
const QUIET = has("quiet");

if (Number.isInteger(PORT) === false || PORT < 1 || PORT > 65535) {
	console.error(`✗ --port must be a port number, got ${String(flag("port"))}`);
	process.exit(2);
}

const say = (line) => {
	if (QUIET === false) console.log(line);
};

// ── the live-home guard, deliberately the first thing that runs ──
//
// A guard that boots against the real harness home fights whatever the user is
// running. This is not hypothetical: a previous revision of the bash guard was
// invoked without its `DSH_HOME` prefix, and `dsh plugin add` wrote into the
// live `~/.dsh/profiles/web`. Assert before anything else can write.
const LIVE_HOME = resolve(join(homedir(), ".dsh"));
const HOME_DIR = resolve(flag("home") ?? mkdtempSync(join(tmpdir(), "dsh-boot-")));

if (HOME_DIR === LIVE_HOME || HOME_DIR === resolve(homedir())) {
	console.error(`✗ refusing to use the live harness home as a throwaway: ${HOME_DIR}`);
	console.error("  A boot against it fights the user's running sessions. Pass a fresh --home.");
	process.exit(2);
}

// Every exit path removes the throwaway home. A failure path returns early, so
// cleanup hung off the end of the happy path would leak a whole profile — and
// it would leak precisely on the runs someone is re-running while debugging.
process.on("exit", () => {
	try {
		rmSync(HOME_DIR, { recursive: true, force: true });
	} catch {
		// Nothing useful to do at exit; a leftover temp directory is not worth
		// masking the real exit status for.
	}
});

// ── harness discovery ──────────────────────────────────────────
/** The command to run `dsh` with, as an argv prefix. */
function commandFor(path) {
	if (/\.(m|c)?js$/.test(path)) return { cmd: process.execPath, args: [path] };
	return { cmd: path, args: [] };
}

function discoverHarness() {
	const tried = [];

	if (DSH_BIN !== undefined) {
		tried.push(`--dsh-bin ${DSH_BIN}`);
		if (existsSync(DSH_BIN)) {
			const r = commandFor(DSH_BIN);
			return { ...r, how: `--dsh-bin ${DSH_BIN}` };
		}
	}

	const install = process.env.DSH_INSTALL;
	if (install !== undefined && install !== "") {
		tried.push(`$DSH_INSTALL=${install}`);
		// `DSH_INSTALL` names a harness root; accept the shapes people write.
		for (const candidate of [
			join(install, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
			join(install, "@deepseek-ai", "dsh", "lib", "bin.js"),
			join(install, "lib", "bin.js"),
		]) {
			if (existsSync(candidate)) {
				return { cmd: process.execPath, args: [candidate], how: `$DSH_INSTALL (${candidate})` };
			}
		}
	}

	const local = join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
	tried.push(`<repo>/node_modules (${local})`);
	if (existsSync(local)) {
		return { cmd: process.execPath, args: [local], how: `<repo>/node_modules (${local})` };
	}

	tried.push("`dsh` on PATH");
	// `shell` only on Windows, where the shim is a `.cmd` and cannot be spawned
	// directly. Node uses cmd.exe there — this is not Git Bash and cannot
	// rewrite a POSIX path behind our back.
	const useShell = process.platform === "win32";
	const probe = spawnSync("dsh", ["--version"], { encoding: "utf8", shell: useShell });
	if (probe.status === 0 && (probe.stdout ?? "").trim() !== "") {
		return { cmd: "dsh", args: [], shell: useShell, how: "`dsh` on PATH" };
	}

	return { tried };
}

const harness = discoverHarness();
if (harness.cmd === undefined) {
	console.error("✗ no harness found — this is an environment problem, not a plugin problem.");
	console.error("  Tried, in order:");
	for (const t of harness.tried) console.error(`    · ${t}`);
	console.error("");
	console.error("  Point at one of these, then re-run:");
	console.error('    export DSH_INSTALL="C:/BL/AI/dsh-harness"                                   # Windows desktop harness');
	console.error('    export DSH_INSTALL="$HOME/.local/share/nodejs/node-v24.21.0-linux-x64/lib/node_modules/@deepseek-ai/dsh"');
	console.error("    npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2  # or the local install");
	console.error("    node tools/boot-check.mjs --dsh-bin <path/to/@deepseek-ai/dsh/lib/bin.js>   # or by hand");
	process.exit(2);
}

// ── helpers ────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true when something accepts a TCP connection on the port. */
function probe(port) {
	return new Promise((resolveProbe) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const done = (answer) => {
			socket.removeAllListeners();
			socket.destroy();
			resolveProbe(answer);
		};
		socket.setTimeout(2000);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

const run = (args, extraEnv) =>
	spawnSync(harness.cmd, [...harness.args, ...args], {
		cwd: REPO,
		encoding: "utf8",
		shell: harness.shell ?? false,
		env: { ...process.env, DSH_HOME: HOME_DIR, ...extraEnv },
	});

// ── report header ──────────────────────────────────────────────
// Deliberately forgiving: the header is diagnostic, and a manifest the guard
// cannot read is a thing assertion A/B should report, not a reason to die
// before naming which one failed. A crash here reads like a guard bug.
let pkgName = "(package.json unreadable)";
try {
	pkgName = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).name ?? pkgName;
} catch {
	// reported below, and again by assertion B
}

say(`boot-check — ${pkgName}`);
say(`  repo:     ${REPO}`);
say(`  harness:  ${harness.how}`);
say(`  version:  ${(spawnSync(harness.cmd, [...harness.args, "--version"], { encoding: "utf8", shell: harness.shell ?? false }).stdout ?? "").trim() || "(printed nothing)"}`);
say(`  home:     ${HOME_DIR}`);
say(`  port:     ${PORT}`);
say("");

const results = [];
const record = (id, ok, detail) => {
	results.push({ id, ok, detail });
	say(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
};

justRun().catch((err) => {
	console.error(`\n✗ boot-check itself threw: ${err?.stack ?? err}`);
	process.exit(1);
});

async function justRun() {
	// ── A · the profile accepts the plugin ─────────────────────
	mkdirSync(join(HOME_DIR, "profiles", PROFILE), { recursive: true });
	const add = run(["plugin", "--profile", PROFILE, "add", REPO]);
	const addOk = add.status === 0;

	// Classify "the harness cannot even run" separately from "the plugin is
	// broken": a missing package manager is an environment problem, and calling
	// it a plugin failure is how a red gate gets ignored.
	const addText = `${add.stdout ?? ""}${add.stderr ?? ""}`;
	const envish = /pnpm[^\n]*(not found|missing|not on PATH)|install pnpm/i.test(addText);
	record("A  plugin add", addOk, addOk ? "exit 0" : `exit ${String(add.status)}`);
	if (addOk === false) {
		console.error(addText.trim());
		if (envish) {
			console.error("\n✗ the package manager is missing — environment, not plugin.");
			console.error("  Fix: npm install -g pnpm@12");
			process.exit(2);
		}
		process.exit(1);
	}

	// ── B · the row resolves to this package ───────────────────
	//
	// Read the two files rather than the composed tree. `--dump-config` cannot
	// see this: a row that does not resolve still appears, in an exit-0 dump
	// with empty stderr. That is the gap assertion C exists to cover.
	const patchPath = join(REPO, "cordis.patch.yml");
	// Every `name:` scalar in the patch must be the package name. This bundle
	// declares exactly one row, so a stricter reading is available than "the
	// package appears somewhere" — and a second, stale row would break the boot
	// just as thoroughly as a wrong single one. Revisit if the bundle ever
	// declares more than one row.
	const rowNames = (existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "")
		.split("\n")
		.map((line) => /^\s*name:\s*(\S+)\s*$/.exec(line))
		.filter((m) => m !== null)
		.map((m) => m[1]);

	let bOk = false;
	let bDetail;
	try {
		const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
		bOk = typeof pkg.name === "string" && rowNames.length > 0 && rowNames.every((n) => n === pkg.name);
		bDetail = bOk
			? `${pkg.name} (${String(rowNames.length)} row name[s])`
			: `row declares ${JSON.stringify(rowNames)}, package is ${String(pkg.name)}`;
	} catch (err) {
		bDetail = `package.json is unreadable: ${err.message}`;
	}
	record("B  row name == package name", bOk, bDetail);
	if (bOk === false) {
		console.error("\n✗ The patch row's `name` must be the package name: it is resolved against the");
		console.error("  profile at boot, so a stale one produces ERR_MODULE_NOT_FOUND and a profile");
		console.error("  that will not start — while --dump-config still reports a clean tree.");
		process.exit(1);
	}

	// ── C and D · the boot ─────────────────────────────────────
	//
	// Refuse to test against a port that is already answering. A leftover
	// listener from an earlier run would make assertion C pass without the
	// plugin ever starting — a guard that reports success for the wrong reason
	// is worse than no guard.
	if (await probe(PORT)) {
		console.error(`✗ something is already listening on 127.0.0.1:${String(PORT)} — refusing to test against it.`);
		console.error("  Assertion C would pass on that listener without the plugin starting.");
		console.error("  Free the port, or pass --port with a free one.");
		process.exit(2);
	}

	const child = spawn(harness.cmd, [...harness.args, "--profile", PROFILE, "--port", String(PORT), "--no-open"], {
		cwd: REPO,
		shell: harness.shell ?? false,
		env: { ...process.env, DSH_HOME: HOME_DIR },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += String(d)));
	child.stderr.on("data", (d) => (stderr += String(d)));

	// Liveness must consider `signalCode` as well as `exitCode`. Measured on
	// Windows: after `kill("SIGTERM")` the child's `signalCode` flips to
	// "SIGTERM" immediately while `exitCode` stays `null` **forever** — so a
	// loop watching `exitCode` alone believes a dead process is still running.
	const alive = () => child.exitCode === null && child.signalCode === null;

	const deadline = Date.now() + TIMEOUT;
	let answering = false;
	let stderrAtAnswer = null;
	let exitedEarly = false;
	let diedAfterAnswering = false;
	let droppedAfterAnswering = false;

	while (Date.now() < deadline) {
		if (await probe(PORT)) {
			// Snapshot at the instant it answers — assertion D is about that
			// moment, not about whatever the process says afterwards.
			stderrAtAnswer = stderr;
			answering = true;
			break;
		}
		if (alive() === false) {
			exitedEarly = true;
			break;
		}
		await sleep(250);
	}

	// ★ Assertion C is "answers **and stays** answering", not "answered once".
	//
	// Measured on this repository, with a `throw` at the top of `index.js` and
	// the row name left correct: the harness binds the port, serves for about
	// 200 ms, then dies with a 7 KB stack trace.
	//
	//   t=900ms   alive, port answering, stderr 0 bytes
	//   t=1100ms  alive, port NOT answering
	//   t=1200ms  exited,   stderr 7411 bytes
	//
	// A single `net.connect` samples that window and reports a completely
	// broken plugin as booting — which is worse than having no guard at all.
	// So after the first answer, hold and require the process to still be
	// alive, still answering, throughout.
	if (answering) {
		const settleBy = Date.now() + SETTLE;
		while (Date.now() < settleBy) {
			await sleep(200);
			if (alive() === false) {
				diedAfterAnswering = true;
				break;
			}
			if ((await probe(PORT)) === false) {
				droppedAfterAnswering = true;
				break;
			}
		}
	}

	// SIGTERM, never SIGKILL: a SIGKILLed harness leaves its MCP children with
	// a broken stdout, and they answer with tracebacks.
	if (alive()) {
		child.kill("SIGTERM");
		const stopBy = Date.now() + 5000;
		while (alive() && Date.now() < stopBy) await sleep(100);
		if (alive()) {
			say("  (note: it ignored SIGTERM, so it had to be killed)");
			child.kill("SIGKILL");
			const killBy = Date.now() + 5000;
			while (alive() && Date.now() < killBy) await sleep(100);
		}
	}

	const cOk = answering && diedAfterAnswering === false && droppedAfterAnswering === false;
	record(
		"C  port answers and stays up",
		cOk,
		cOk
			? `127.0.0.1:${String(PORT)} held for ${String(SETTLE)}ms`
			: answering === false
				? exitedEarly
					? "the process exited on its own without serving"
					: `nothing answered within ${String(TIMEOUT)}ms`
				: diedAfterAnswering
					? "it answered, then died — the plugin failed to load"
					: "it answered, then stopped answering",
	);
	record("D  stderr empty at that moment", answering && stderrAtAnswer === "", answering ? `${String((stderrAtAnswer ?? "").length)} bytes` : "not reached");

	if (cOk === false || (stderrAtAnswer ?? "").length > 0) {
		if (stdout.trim() !== "") console.error(`\n--- boot stdout ---\n${stdout.trim()}`);
		if (stderr.trim() !== "") console.error(`\n--- boot stderr ---\n${stderr.trim()}`);
	}

	// ── verdict ────────────────────────────────────────────────
	// (the throwaway home is removed by the exit hook, so a failure path — which
	// returns early — does not leak it either)

	const failed = results.filter((r) => r.ok === false);
	say("");
	if (failed.length === 0) {
		say(`✓ boot check passed: installed, mounted, and answered on port ${String(PORT)}`);
		process.exit(0);
	}
	console.error(`✗ boot check failed on: ${failed.map((r) => r.id.trim()).join(", ")}`);
	process.exit(1);
}
