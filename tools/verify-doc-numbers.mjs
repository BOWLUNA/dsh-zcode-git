#!/usr/bin/env node
/**
 * The numbers in the documentation must match the numbers the code produces.
 *
 * Why this exists: no other guard can see a stale count. A README that says
 * "93 tests" while the suite runs 95 is a claim like any other, and this
 * repository's rule is that claims are checked rather than remembered. Writing
 * this file immediately found a drifted test count and a layer count that
 * disagreed with the list beneath it.
 *
 * It reads the real values by *doing the thing* — running the suite, calling
 * `defineTools`, parsing the pinned config — never by scanning documentation
 * against itself.
 *
 * Run: node tools/verify-doc-numbers.mjs   (CI runs it after the suite)
 * Exit: 0 when every claim matches; 1 with file:line and both values otherwise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

/**
 * Run the suite and read the real total.
 *
 * The count comes from the runner rather than from counting `test(` calls,
 * because a nested subtest or a loop-generated case would be invisible to a
 * source scan.
 *
 * @returns the number of test cases the runner reported.
 */
function measureTests() {
	const output = execFileSync(process.execPath, ["--test"], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 600_000,
	});
	const match = /^# tests (\d+)$/m.exec(output);
	if (match === null) {
		console.error("✗ could not read `# tests N` from the node --test output");
		process.exit(2);
	}
	return Number(match[1]);
}

/**
 * Read the registered tool names by calling the plugin, not by grepping it.
 *
 * @returns the tool names in registration order.
 */
async function measureTools() {
	const mod = await import(new URL("../index.js", import.meta.url).href);
	const settings = { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: true };
	return mod.defineTools({ get: () => undefined }, settings).map((definition) => definition.name);
}

/**
 * Count the pinned `-c` settings declared in `src/exec.js`.
 *
 * @returns the number of `"-c"` entries in the PINNED_CONFIG literal.
 */
function measurePinned() {
	const source = readFileSync(join(REPO, "src", "exec.js"), "utf8");
	const block = /const PINNED_CONFIG = \[([\s\S]*?)\n\];/.exec(source);
	if (block === null) {
		console.error("✗ PINNED_CONFIG not found in src/exec.js — did it get renamed?");
		process.exit(2);
	}
	return (block[1].match(/"-c"/g) ?? []).length;
}

/**
 * Compare every count claim on every line of one file.
 *
 * @param rel - repository-relative path.
 * @param rules - `[pattern, key, label]` triples; the pattern captures the number.
 * @param actual - the measured values.
 */
function checkCounts(rel, rules, actual) {
	const lines = readFileSync(join(REPO, rel), "utf8").split("\n");
	lines.forEach((line, index) => {
		for (const [pattern, key, label] of rules) {
			const match = pattern.exec(line);
			if (match === null) continue;
			const documented = Number(match[1]);
			if (documented !== actual[key]) {
				problems.push(
					`${rel}:${String(index + 1)} says ${label} is ${match[1]}, but it is ${String(actual[key])}\n    ${line.trim()}`,
				);
			}
		}
	});
}

const toolNames = await measureTools();
const actual = { tests: measureTests(), tools: toolNames.length, pinned: measurePinned() };
console.log(`actual: ${String(actual.tests)} tests, ${String(actual.tools)} tools, ${String(actual.pinned)} pinned settings`);

// Each rule is `[pattern, measured key, label].` Both languages are covered so a
// translated document cannot drift on its own.
const TEST_RULES = [
	[/(\d+) tests?\b/, "tests", "the test count"],
	[/(\d+) cases?\b/, "tests", "the test count"],
	[/(\d+) 个测试/, "tests", "测试数"],
	[/(\d+) 个用例/, "tests", "测试数"],
];
const PINNED_RULES = [
	[/(\d+) pinned\b/, "pinned", "the pinned-setting count"],
	[/(\d+) 项 `git -c`/, "pinned", "钉死配置项数"],
];
const TOOL_RULES = [
	[/(\d+) tools?\b/, "tools", "the tool count"],
	[/(\d+) 个工具/, "tools", "工具数"],
];

for (const rel of ["README.md", "README.zh.md", "AGENTS.md", "CHANGELOG.md", "CHANGELOG.zh.md"]) {
	checkCounts(rel, [...TEST_RULES, ...PINNED_RULES, ...TOOL_RULES], actual);
}

// Every registered tool must be named in the README's tool table — a new tool
// that never reaches the documentation is the failure a count alone cannot see.
const readme = readFileSync(join(REPO, "README.md"), "utf8");
for (const toolName of toolNames) {
	if (!readme.includes(`\`${toolName}\``)) problems.push(`README.md never mentions the tool \`${toolName}\``);
}

// The declared compatibility range is a claim too, and the one users act on.
const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const range = manifest.engines.dsh;
if (!readme.includes(range)) problems.push(`README.md does not state the declared dsh range ${range}`);
for (const rel of ["README.zh.md"]) {
	if (!readFileSync(join(REPO, rel), "utf8").includes(range)) {
		problems.push(`${rel} does not state the declared dsh range ${range}`);
	}
}

if (problems.length > 0) {
	console.error("");
	for (const problem of problems) console.error(`✗ ${problem}`);
	console.error("");
	console.error(`documented numbers disagree with reality in ${String(problems.length)} place(s).`);
	console.error("Fix the documentation, not this check — the check reads real results.");
	process.exit(1);
}
console.log(`✓ documentation matches reality (${String(actual.tests)} tests / ${String(actual.tools)} tools / ${String(actual.pinned)} pinned / dsh ${range})`);
