import assert from "node:assert/strict";
import { test } from "node:test";

import {
	clampInteger,
	validateBranchName,
	validateCommitMessage,
	validateRepoRelativePath,
	validateRepoRelativePaths,
	validateRevision,
} from "../src/validate.js";

test("validateRepoRelativePaths accepts ordinary paths", () => {
	assert.equal(validateRepoRelativePaths(undefined), null);
	assert.equal(validateRepoRelativePaths([]), null);
	assert.equal(validateRepoRelativePaths(["src/a.js", "docs/readme.md", "中文目录/文件.txt"]), null);
	// A `..` inside a name is not traversal.
	assert.equal(validateRepoRelativePaths(["a..b", "..."]) , null);
});

test("validateRepoRelativePaths rejects non-arrays and non-strings", () => {
	assert.match(validateRepoRelativePaths("src/a.js"), /must be an array/);
	assert.match(validateRepoRelativePaths([42]), /must be a string/);
});

test("validateRepoRelativePath rejects absolute paths on either separator style", () => {
	assert.match(validateRepoRelativePath("/etc/passwd"), /absolute/);
	assert.match(validateRepoRelativePath("C:/Users/me/.ssh"), /drive-absolute/);
	assert.match(validateRepoRelativePath("C:\\Users\\me\\.ssh"), /drive-absolute/);
	// Drive-relative: resolves against that drive's current directory, which is
	// not the session directory.
	assert.match(validateRepoRelativePath("C:foo"), /drive-absolute/);
	assert.match(validateRepoRelativePath("\\\\server\\share\\x"), /UNC/);
});

test("validateRepoRelativePath rejects traversal with either separator", () => {
	assert.match(validateRepoRelativePath("../outside.txt"), /escapes the repository root/);
	assert.match(validateRepoRelativePath("a/../../outside.txt"), /escapes the repository root/);
	// The Windows-style form must not slip past a `/`-only check.
	assert.match(validateRepoRelativePath("..\\..\\outside.txt"), /escapes the repository root/);
	assert.match(validateRepoRelativePath("a\\..\\..\\b"), /escapes the repository root/);
});

test("validateRepoRelativePath rejects control characters", () => {
	assert.match(validateRepoRelativePath("a\u0000b"), /control character/);
	assert.match(validateRepoRelativePath("a\nb"), /control character/);
});

test("validateRepoRelativePath rejects empty strings", () => {
	assert.match(validateRepoRelativePath(""), /must not be empty/);
});

test("validateRepoRelativePath applies the Windows-only hazards on Windows", { skip: process.platform !== "win32" }, () => {
	// An alternate data stream is a distinct file that most tooling shows as
	// part of the base name.
	assert.match(validateRepoRelativePath("notes.txt:hidden"), /alternate data stream/);
	assert.match(validateRepoRelativePath("src/con.txt"), /reserved Windows device/);
	assert.match(validateRepoRelativePath("NUL"), /reserved Windows device/);
	assert.match(validateRepoRelativePath("com1"), /reserved Windows device/);
});

test("validateCommitMessage accepts everything a shell would mangle", () => {
	// These are the exact shapes that a shell-mediated implementation cannot
	// deliver intact — and the reason this plugin exists.
	assert.equal(validateCommitMessage("fix: handle %PATH% expansion"), null);
	assert.equal(validateCommitMessage("fix: drop $(rm -rf /) from the template"), null);
	assert.equal(validateCommitMessage('feat: accept "quoted" and `backticked` text'), null);
	assert.equal(validateCommitMessage("refactor: 中文提交信息，含全角标点。"), null);
	assert.equal(validateCommitMessage("subject line\n\nbody paragraph\nsecond body line"), null);
	assert.equal(validateCommitMessage("fix: 100% complete & done"), null);
});

test("validateCommitMessage rejects the shapes git cannot receive intact", () => {
	assert.match(validateCommitMessage("   "), /must not be empty/);
	assert.match(validateCommitMessage(""), /must not be empty/);
	assert.match(validateCommitMessage(42), /must be a string/);
	// A NUL cannot survive the platform call, so accepting it would commit a
	// silently truncated message.
	assert.match(validateCommitMessage("a\u0000b"), /NUL/);
	assert.match(validateCommitMessage("x".repeat(10_001)), /the limit is 10000/);
	assert.equal(validateCommitMessage("x".repeat(10_000)), null);
});

test("validateCommitMessage honours a custom ceiling", () => {
	assert.match(validateCommitMessage("abcdef", { maxLength: 3 }), /limit is 3/);
});

test("validateBranchName accepts ordinary names and rejects git-invalid ones", () => {
	assert.equal(validateBranchName("main"), null);
	assert.equal(validateBranchName("feature/add-git-tools"), null);
	assert.equal(validateBranchName("release/2026.09"), null);

	assert.match(validateBranchName(""), /must not be empty/);
	assert.match(validateBranchName("has space"), /forbids/);
	assert.match(validateBranchName("tilde~1"), /forbids/);
	assert.match(validateBranchName("caret^"), /forbids/);
	assert.match(validateBranchName("colon:x"), /forbids/);
	assert.match(validateBranchName("question?"), /forbids/);
	assert.match(validateBranchName("star*"), /forbids/);
	assert.match(validateBranchName("bracket["), /forbids/);
	assert.match(validateBranchName("back\\slash"), /forbids/);
	assert.match(validateBranchName("double..dot"), /must not contain ".."/);
	assert.match(validateBranchName("at@{brace"), /@\{/);
	assert.match(validateBranchName("/leading"), /begin or end/);
	assert.match(validateBranchName("trailing/"), /begin or end/);
	assert.match(validateBranchName(".leading"), /begin or end/);
	assert.match(validateBranchName("trailing."), /begin or end/);
	assert.match(validateBranchName("locked.lock"), /\.lock/);
	assert.match(validateBranchName("double//slash"), /consecutive slashes/);
	assert.match(validateBranchName("@"), /single character/);
});

test("validateRevision rejects a leading dash", () => {
	// A leading `-` would be read by git as an option, since revisions appear
	// before the `--` separator.
	assert.match(validateRevision("--upload-pack=evil"), /must not begin with "-"/);
	assert.match(validateRevision("-n1"), /must not begin with "-"/);
	assert.equal(validateRevision("HEAD~5"), null);
	assert.equal(validateRevision("main..feature"), null);
	assert.equal(validateRevision("stash@{1}"), null);
	assert.match(validateRevision(""), /must not be empty/);
	assert.match(validateRevision(7), /must be a string/);
});

test("clampInteger keeps model-supplied counts in range", () => {
	assert.equal(clampInteger(5, 10, 1, 100), 5);
	assert.equal(clampInteger(undefined, 10, 1, 100), 10);
	assert.equal(clampInteger("20", 10, 1, 100), 10);
	assert.equal(clampInteger(0, 10, 1, 100), 1);
	assert.equal(clampInteger(-5, 10, 1, 100), 1);
	assert.equal(clampInteger(10_000, 10, 1, 100), 100);
	assert.equal(clampInteger(Number.NaN, 10, 1, 100), 10);
	// Fractional input from a model is truncated rather than rejected.
	assert.equal(clampInteger(7.9, 10, 1, 100), 7);
});
