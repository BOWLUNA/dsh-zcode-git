#!/usr/bin/env node
/**
 * Bilingual pairing check. Discovers every `*.i18n.yaml` itself — nothing is
 * registered by hand, so a new document pair cannot be forgotten.
 *
 * Four layers, because each one misses a failure the others catch:
 *   1. **Hashes** — did either side change since it was last confirmed paired?
 *      Catches "only one side was edited".
 *   2. **Language entry** — does each side link to the other? Catches a missing
 *      language-switch line.
 *   3. **Language purity** — long-form prose in the wrong language. Catches
 *      "a whole Chinese paragraph pasted into the English file", which both a
 *      hash and a structure comparison report as fine.
 *   4. **Structural parity** — heading levels, fences, table rows, quotes and
 *      list items compared item by item. Catches "a whole section exists on one
 *      side only", which a hash can never catch when both sides were edited.
 *
 * Usage:
 *   node tools/verify-translation-pairing.mjs           # check, exit 1 on drift
 *   node tools/verify-translation-pairing.mjs --write   # re-record current hashes
 *
 * No git binary is required: a git blob hash is just
 * sha1("blob <byte length>\0" + content), which this computes directly.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set([".git", "node_modules", ".github", ".refs", ".lab"]);

/**
 * Find every `*.i18n.yaml` under the repository.
 *
 * @param dir - directory to scan.
 * @param out - accumulator.
 * @returns absolute paths, sorted for a stable report.
 */
function findRecords(dir = REPO, out = []) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) findRecords(full, out);
		else if (entry.endsWith(".i18n.yaml")) out.push(full);
	}
	return out.sort();
}

/**
 * Compute git's blob hash for a string.
 *
 * @param text - file contents.
 * @returns the 40-character hex sha1 git would record.
 */
function blobHash(text) {
	const body = Buffer.from(text, "utf8");
	return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, "utf8"), body])).digest("hex");
}

/**
 * Read the `file: hash` pairs out of a record. Comments and blank lines are
 * ignored, so the header comment can be edited freely.
 *
 * @param path - the `*.i18n.yaml` file.
 * @returns a map of repository-relative path to recorded hash.
 */
function readRecord(path) {
	const out = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^([^\s#][^:]*):\s*([0-9a-f]{40})\s*$/.exec(line);
		if (match !== null) out[match[1].trim()] = match[2];
	}
	return out;
}

const RECORD_HEADER = [
	"# Bilingual pairing record: the git blob hash of each side when the two were",
	"# last confirmed to say the same thing. Both files are equally authoritative —",
	"# after editing either one, edit the other and re-record with:",
	"#   node tools/verify-translation-pairing.mjs --write",
].join("\n");

/**
 * Summarize the shape of a markdown document.
 *
 * Fenced blocks are skipped so a `#` inside a shell example is not counted as a
 * heading — otherwise two documents with the same content could report
 * different shapes just because one code sample is longer.
 *
 * @param text - markdown source.
 * @returns counts plus the heading-level sequence.
 */
function shape(text) {
	const heads = [];
	let fence = 0;
	let inFence = false;
	let tables = 0;
	let quotes = 0;
	let items = 0;
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			fence += 1;
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (line.startsWith("#")) heads.push(line.length - line.trimStart().length);
		else if (line.startsWith("|")) tables += 1;
		else if (line.startsWith(">")) quotes += 1;
		else if (/^\s*(-|\*|\d+\.)\s/.test(line)) items += 1;
	}
	return { heads, fence, tables, quotes, items };
}

/**
 * Look for long prose in the wrong language.
 *
 * The thresholds are deliberately loose to avoid false positives: fenced code,
 * inline code, quoted strings and 「…」 spans are stripped first (raw output,
 * commands and quoted UI text are legitimately untranslated), and only a run of
 * 12+ CJK characters (on the English side) or 10+ consecutive English words (on
 * the Chinese side) is reported.
 *
 * @param full - absolute path of one side.
 * @param rel - repository-relative path, used to pick the expected language.
 * @returns problem descriptions, empty when clean.
 */
function languagePurity(full, rel) {
	const englishSide = !/\.zh\.md$/.test(rel);
	const problems = [];
	let inFence = false;
	let scanned = 0;
	const lines = readFileSync(full, "utf8").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		scanned += 1;
		const target = line.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ").replace(/「[^」]*」/g, " ");
		const hit = englishSide
			? /[\u4e00-\u9fff]{12,}/.exec(target)
			: /(?:[A-Za-z][A-Za-z'-]*\s+){9,}[A-Za-z][A-Za-z'-]*/.exec(target);
		if (hit !== null) {
			problems.push(
				`${rel}:${String(index + 1)} ${englishSide ? "run of Chinese in the English document" : "run of English in the Chinese document"} → ${hit[0].slice(0, 40)}`,
			);
		}
	}
	// Guard against a vacuous pass: no real markdown has fewer than five lines of
	// prose, so finding fewer means the check itself stopped working.
	if (scanned < 5) problems.push(`${rel}: only ${String(scanned)} prose lines scanned — the language check may be vacuous`);
	return problems;
}

const write = process.argv.includes("--write");
const records = findRecords();
let failures = 0;

if (records.length === 0) {
	console.error("✗ no *.i18n.yaml found — every translated document pair needs a record beside it");
	process.exit(1);
}

for (const recordPath of records) {
	const rel = relative(REPO, recordPath).replace(/\\/g, "/");
	const files = Object.keys(readRecord(recordPath));
	if (files.length !== 2) {
		console.error(`✗ ${rel}: expected exactly two files in the record, found ${String(files.length)}`);
		failures += 1;
		continue;
	}

	if (write) {
		const lines = [RECORD_HEADER];
		for (const file of files) lines.push(`${file}: ${blobHash(readFileSync(join(REPO, file), "utf8"))}`);
		writeFileSync(recordPath, `${lines.join("\n")}\n`);
		console.log(`✓ ${rel} re-recorded`);
		continue;
	}

	const recorded = readRecord(recordPath);
	const actual = {};
	let missing = false;
	for (const file of files) {
		const full = join(REPO, file);
		if (!existsSync(full)) {
			console.error(`✗ ${rel}: ${file} is recorded but does not exist`);
			missing = true;
			continue;
		}
		actual[file] = blobHash(readFileSync(full, "utf8"));
	}
	if (missing) {
		failures += 1;
		continue;
	}

	// Report every layer at once rather than stopping at the first: one edit
	// round should reveal everything that needs fixing.
	const problems = [];

	const drifted = files.filter((file) => recorded[file] !== actual[file]);
	if (drifted.length > 0) {
		problems.push(
			`changed since the last record → ${drifted.join(", ")}\n` +
				"    Both sides are equally authoritative: confirm the other side kept up, then run\n" +
				"    node tools/verify-translation-pairing.mjs --write",
		);
	}

	const missingLink = files.filter((file) => {
		const partner = files.find((other) => other !== file);
		return !readFileSync(join(REPO, file), "utf8").includes(partner.split("/").pop());
	});
	if (missingLink.length > 0) {
		problems.push(
			`no link to the other language → ${missingLink.join(", ")}\n` +
				"    Each side needs one line such as `English | [中文](X.zh.md)`.",
		);
	}

	const purity = files.flatMap((file) => languagePurity(join(REPO, file), file));
	if (purity.length > 0) problems.push(`mixed languages →\n${purity.map((line) => `    ${line}`).join("\n")}`);

	const [a, b] = files.map((file) => shape(readFileSync(join(REPO, file), "utf8")));
	const labels = ["heading levels", "code fences", "table rows", "quote lines", "list items"];
	const keys = ["heads", "fence", "tables", "quotes", "items"];
	const mismatch = keys
		.map((key, i) =>
			JSON.stringify(a[key]) === JSON.stringify(b[key])
				? null
				: `${labels[i]}: ${files[0]}=${JSON.stringify(a[key])} ${files[1]}=${JSON.stringify(b[key])}`,
		)
		.filter(Boolean);
	if (mismatch.length > 0) {
		problems.push(`structure differs — ${mismatch.join("; ")}\n    Usually a section added or removed on one side only.`);
	}

	if (problems.length > 0) {
		console.error(`✗ ${rel}:`);
		for (const problem of problems) console.error(`  - ${problem}`);
		failures += 1;
	} else {
		console.log(`✓ ${rel} paired (hash + language entry + purity + structure)`);
	}
}

console.log(failures === 0 ? "translation pairing: OK" : `translation pairing: ${String(failures)} group(s) failed`);
process.exit(failures === 0 ? 0 : 1);
