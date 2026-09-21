#!/usr/bin/env node
/**
 * The single test entry point.
 *
 * CI, `tools/verify-doc-numbers.mjs` and contributors all run this rather than
 * `node --test` directly, so there is one place that decides which suites
 * exist and one shape of summary to parse. A suite added to `test/` but
 * forgotten here would otherwise be silently skipped everywhere.
 *
 * It prints both the raw `# tests N` counters (what the doc-numbers guard
 * reads) and a human summary line.
 *
 * Usage: node test/run.mjs
 * Exit:  0 when every case passes; 1 when any fails; 2 when the runner output
 *        cannot be parsed, which means this file no longer matches the
 *        runner's format and must be fixed rather than trusted.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(TEST_DIR);

/** The suites, by filename, in a stable order so output is diffable. */
const suites = readdirSync(TEST_DIR)
	.filter((name) => name.endsWith(".test.js"))
	.sort();

if (suites.length === 0) {
	console.error("✗ no *.test.js files found in test/ — refusing to report success");
	process.exit(2);
}

console.log(`suites: ${String(suites.length)}`);
for (const suite of suites) console.log(`  ${suite}`);
console.log("");

const result = spawnSync(
	process.execPath,
	// The reporter is pinned because Node changed its default between 20 and 24:
	// 20 emits TAP (`# tests 95`), 24 emits the spec reporter (`ℹ tests 95`).
	// Parsing either one alone breaks the other, and the failure looks like a
	// test failure rather than a reporter change.
	["--test", "--test-reporter=tap", ...suites.map((name) => join(TEST_DIR, name))],
	{
		cwd: REPO,
		encoding: "utf8",
		// stdout is captured for parsing; stderr streams through so a failure is
		// visible while it happens rather than only in the summary.
		stdio: ["ignore", "pipe", "inherit"],
		timeout: 900_000,
	},
);

const stdout = typeof result.stdout === "string" ? result.stdout : "";
const count = (label) => {
	// Accept both prefixes anyway, with optional indentation: belt and braces in
	// case a future Node changes the reporter again and the pin stops applying.
	const match = new RegExp(`^[ \\t]*(?:#|ℹ)[ \\t]*${label} (\\d+)[ \\t]*$`, "m").exec(stdout);
	return match === null ? null : Number(match[1]);
};

const tests = count("tests");
const passed = count("pass");
const failed = count("fail");
const skipped = count("skipped");

if (tests === null || passed === null || failed === null) {
	// Printing the tail helps whoever has to fix this file.
	console.error("✗ could not parse the runner output — this file no longer matches `node --test`.");
	console.error("  last lines of stdout:");
	for (const line of stdout.split("\n").slice(-15)) console.error(`    ${line}`);
	process.exit(2);
}

console.log(`# tests ${String(tests)}`);
console.log(`# pass ${String(passed)}`);
console.log(`# fail ${String(failed)}`);
console.log(`# skipped ${String(skipped ?? 0)}`);
console.log(`结果: ${String(passed)} 通过, ${String(failed)} 失败`);

process.exit(failed === 0 && result.status === 0 ? 0 : 1);
