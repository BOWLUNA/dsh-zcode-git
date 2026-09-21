#!/usr/bin/env node
/**
 * The declared compatibility range must contain every harness version we test.
 *
 * The range in `engines.dsh` is a claim users act on: `dsh plugin add` will
 * happily install onto a version outside it, and the failure mode is a schema
 * DSL mismatch that surfaces as a rejected tool definition rather than as a
 * version error. So the range is checked three ways:
 *
 *   1. every version this project has actually been exercised against,
 *   2. every version the CI matrix installs,
 *   3. the version the current run installed, when `--dsh <version>` is passed.
 *
 * The syntax supported is the subset package.json uses: space-separated
 * comparators (`>=0.1.5-rc.2 <0.2.0-0`). That is deliberate — a full semver
 * implementation is a dependency this plugin does not need.
 *
 * Run: node tools/verify-version-consistency.mjs [--dsh <version>]
 * Exit: 0 when consistent; 1 listing each version outside the range.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Harness versions this project has been exercised against by hand — a real
 * boot plus a real turn, not just the suite. Update it when you test a new one.
 */
const TESTED = ["0.1.5-rc.2", "0.1.6-alpha.2"];

/**
 * Parse `x.y.z` or `x.y.z-pre`.
 *
 * @param text - the version string.
 * @returns the parts, or `null` when it is not a version.
 */
function parseVersion(text) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
	if (match === null) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null };
}

/**
 * Order two parsed versions. A prerelease sorts below its own release, which is
 * the only ordering rule this project's ranges depend on.
 *
 * @param a - first version.
 * @param b - second version.
 * @returns -1, 0 or 1.
 */
function compare(a, b) {
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.pre === b.pre) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	return a.pre < b.pre ? -1 : 1;
}

/**
 * Evaluate a space-separated comparator list.
 *
 * @param version - the candidate version.
 * @param range - the declared range.
 * @returns whether the version satisfies every comparator.
 */
function satisfies(version, range) {
	const parsed = parseVersion(version);
	if (parsed === null) return false;
	for (const clause of String(range).trim().split(/\s+/)) {
		const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
		if (match === null) continue;
		const bound = parseVersion(match[2]);
		if (bound === null) return false;
		const order = compare(parsed, bound);
		const operator = match[1] ?? "=";
		if (operator === ">=" && order < 0) return false;
		if (operator === "<=" && order > 0) return false;
		if (operator === ">" && order <= 0) return false;
		if (operator === "<" && order >= 0) return false;
		if (operator === "=" && order !== 0) return false;
	}
	return true;
}

const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const range = manifest.engines?.dsh;
if (range === undefined) {
	console.error("✗ package.json declares no engines.dsh — nothing to check the matrix against");
	process.exit(1);
}

const failures = [];

for (const version of TESTED) {
	if (!satisfies(version, range)) {
		failures.push(`${version} is in the hand-tested list but the declared range is ${range}`);
	}
}

const ciPath = join(REPO, ".github", "workflows", "test.yml");
if (!existsSync(ciPath)) {
	failures.push(".github/workflows/test.yml is missing — the matrix that justifies the range cannot be read");
} else {
	const ci = readFileSync(ciPath, "utf8");
	const matrixVersions = new Set([...ci.matchAll(/dsh:\s*'([^']+)'/g)].map((match) => match[1]));
	if (matrixVersions.size === 0) failures.push("the CI matrix declares no dsh versions");
	for (const version of matrixVersions) {
		if (!satisfies(version, range)) failures.push(`${version} is exercised by CI but the declared range is ${range}`);
	}
}

const flagIndex = process.argv.indexOf("--dsh");
const explicit = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
if (explicit !== undefined && explicit !== "" && !satisfies(explicit, range)) {
	failures.push(`this run installed dsh ${explicit}, which ${range} does not cover`);
}

if (failures.length > 0) {
	console.error("");
	for (const failure of failures) console.error(`✗ ${failure}`);
	console.error("");
	console.error(`version consistency: ${String(failures.length)} problem(s).`);
	console.error("Widen engines.dsh, or drop the version from the matrix and the tested list.");
	process.exit(1);
}

console.log(`✓ version consistency: declared ${range} covers every tested and matrix version${explicit === undefined ? "" : ` (this run: ${explicit})`}`);
