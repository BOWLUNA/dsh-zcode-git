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
 * The syntax supported is the subset package.json uses: `||`-separated branches
 * of space-separated comparators, plus node-semver's rule that a prerelease
 * satisfies a branch only when that branch carries a prerelease comparator on
 * the same `major.minor.patch` tuple. The second rule is not decoration: without
 * it a range like `>=0.1.5-rc.2 <0.2.0-0` appears to cover `0.1.6-alpha.2` and
 * does not, which is how a plugin ships and then meets `ERESOLVE` on install.
 *
 * Run: node tools/verify-version-consistency.mjs [--dsh <version>]
 * Exit: 0 when consistent; 1 listing each version outside the range.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Harness versions this project has been booted against by hand — a real boot
 * plus a real turn, not just the suite. Update it when you test a new one.
 *
 * `0.1.5-rc.3` was deliberately absent until 2026-09-24: the declared range
 * covered it — it is the same `0.1.5` tuple as the `rc.2` this project did boot —
 * but coverage by a range is not the same claim as having run it. It is listed
 * now because it was actually run. It is also npm's `latest`, so it is the
 * version a user reaches without pinning anything, and a range that claims to
 * cover an unexercised `latest` is exactly the claim this list exists to keep
 * honest.
 */
const TESTED = ["0.1.5-rc.2", "0.1.5-rc.3", "0.1.6-alpha.2", "0.1.7-alpha.2"];

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
	return String(range)
		.split("||")
		.some((branch) => satisfiesBranch(parsed, branch));
}

/**
 * Evaluate one `||` branch against a parsed version.
 *
 * Two rules beyond plain comparison, both of which are the difference between
 * agreeing with npm and disagreeing with it:
 *
 * 1. Every comparator in the branch must hold (space-separated = AND).
 * 2. **A prerelease version only satisfies the branch when some comparator in
 *    it sits on the same `major.minor.patch` tuple and itself carries a
 *    prerelease tag.** This is node-semver's rule, and omitting it makes a
 *    broad-looking range appear to match when npm will silently exclude the
 *    version — the failure users meet as `ERESOLVE` on install.
 *
 * @param parsed - the parsed candidate version.
 * @param branch - one `||` branch of a range.
 * @returns whether the version satisfies that branch.
 */
function satisfiesBranch(parsed, branch) {
	const clauses = branch.trim().split(/\s+/).filter((clause) => clause !== "");
	for (const clause of clauses) {
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
	if (parsed.pre === null) return true;
	return clauses.some((clause) => {
		const operand = /^(>=|<=|>|<|=)?(.+)$/.exec(clause)?.[2] ?? "";
		const bound = parseVersion(operand);
		return (
			bound !== null &&
			bound.pre !== null &&
			bound.major === parsed.major &&
			bound.minor === parsed.minor &&
			bound.patch === parsed.patch
		);
	});
}

// Self-check the evaluator against cases where it must agree with npm. A
// silently-permissive evaluator would report success here while users hit
// ERESOLVE on install — the exact failure this guard exists to prevent.
const EVALUATOR_CASES = [
	["0.1.6-alpha.2", ">=0.1.5-rc.2 <0.2.0-0", false, "prerelease on a tuple no comparator mentions"],
	["0.1.6-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true, "explicit branch on the 0.1.6 tuple"],
	["0.1.5-rc.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true, "explicit branch on the 0.1.5 tuple"],
	["0.2.0", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false, "above the ceiling"],
	["0.1.4", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false, "below the floor"],
	["0.1.7", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", true, "a stable release inside"],
	["0.1.5", ">=0.1.5-rc.2 <0.1.6-0", true, "the stable release of the lower tuple"],
	// The version that made this gate worth having. `0.1.7-alpha.2` is a real
	// prerelease on a tuple no comparator mentions, so npm excludes it — and an
	// evaluator without the gate reports the opposite. This case is the
	// regression test for exactly that disagreement.
	["0.1.7-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0", false, "a real prerelease npm excludes"],
	["0.1.7-alpha.2", ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0", true, "and the range that would cover it"],
	["0.1.7-alpha.1", ">=0.1.6-alpha.1 <0.2.0-0", false, "the preset-registry boundary version, still excluded"],
];
for (const [version, range, expected, why] of EVALUATOR_CASES) {
	if (satisfies(version, range) !== expected) {
		console.error(`✗ range evaluator self-check failed (${why}):`);
		console.error(`    satisfies("${version}", "${range}") should be ${String(expected)}`);
		process.exit(2);
	}
}

// The gate above is the only thing standing between "agrees with npm" and
// "silently more permissive than npm", so it is mutation-tested rather than
// assumed. Dropping the prerelease rule must flip `0.1.7-alpha.2` from excluded
// to included; if it does not, these cases are decoration and the guard is
// protecting nothing.
{
	const RANGE = ">=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0";
	const withoutGate = (version) => {
		const parsed = parseVersion(version);
		if (parsed === null) return false;
		// The same branch evaluation with the prerelease rule removed.
		return RANGE.split("||").some((branch) =>
			branch.trim().split(/\s+/).filter(Boolean).every((clause) => {
				const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
				if (match === null) return true;
				const bound = parseVersion(match[2]);
				if (bound === null) return false;
				const order = compare(parsed, bound);
				const operator = match[1] ?? "=";
				if (operator === ">=") return order >= 0;
				if (operator === "<=") return order <= 0;
				if (operator === ">") return order > 0;
				if (operator === "<") return order < 0;
				return order === 0;
			}),
		);
	};
	const gated = satisfies("0.1.7-alpha.2", RANGE);
	const ungated = withoutGate("0.1.7-alpha.2");
	if (ungated !== true || gated !== false) {
		console.error("✗ the prerelease gate is not doing the work it claims:");
		console.error(`    with the gate:    satisfies("0.1.7-alpha.2") = ${String(gated)}  (must be false)`);
		console.error(`    without the gate: ${String(ungated)}  (must be true — otherwise the gate is not what excludes it)`);
		console.error("    An evaluator without this rule is more permissive than npm, which is the defect this guard exists to catch.");
		process.exit(2);
	}
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
	const ci = readFileSync(ciPath, "utf8").replace(/^[ \t]*#.*$/gmu, "");
	const matrixVersions = new Set();
	// `include:` legs spell one version each: `dsh: '0.1.5-rc.3'`.
	for (const match of ci.matchAll(/dsh:\s*'([^']+)'/g)) matrixVersions.add(match[1]);
	// The base list spells several: `dsh: ['0.1.6-alpha.2']`. Reading only the
	// first form left a silent hole — a version placed in the base list was
	// invisible to the one check meant to catch a matrix entry the range does not
	// cover. Measured here 2026-09-24: with `dsh: ['0.1.5-rc.1']` as the base list
	// this guard printed ✓ and exited 0, although CI would then have run an
	// unsupported version on two legs.
	//
	// Full-line comments are stripped above for the same reason the matrix is read
	// from text at all: prose can carry the same literal as a declaration
	// (`# dsh: '0.1.5-rc.1'` made the old pattern fail the build), and the guard
	// must read declarations. Inline trailing comments are not stripped.
	for (const list of ci.matchAll(/dsh:\s*\[([^\]]*)\]/g)) {
		for (const item of list[1].matchAll(/'([^']+)'|"([^"]+)"/g)) matrixVersions.add(item[1] ?? item[2]);
	}
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
