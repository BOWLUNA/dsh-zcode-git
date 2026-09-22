// 探针：会话 cwd 是仓库子目录时，git_status / git_diff 交出的路径是「仓库根相对」
// 还是「工作区相对」？ZCode 明确记录过这个坑并统一到仓库根相对 + 剥前缀。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTools } from "../index.js";

const run = (cmd, args, opts = {}) =>
	new Promise((r) => {
		const c = spawn(cmd, args, { ...opts, windowsHide: true });
		let o = "";
		let e = "";
		c.stdout.on("data", (d) => (o += d));
		c.stderr.on("data", (d) => (e += d));
		c.once("close", (code) => r({ code, o, e }));
	});

// 极简 subprocess stand-in（与本仓 tools/measure.mjs 同形），顺带记录每条命令的原始输出
const record = [];
function service() {
	return {
		spawn(spec) {
			const [file, ...args] = spec.argv;
			const child = spawn(file, args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			const out = [];
			const err = [];
			child.stdout.on("data", (d) => out.push(d));
			child.stderr.on("data", (d) => err.push(d));
			const entry = { argv: args, cwd: spec.cwd, stdout: "" };
			record.push(entry);
			return {
				done: new Promise((res) => child.once("close", (exitCode, signal) => {
					entry.stdout = Buffer.concat(out).toString("utf8");
					res({ exitCode, signal });
				})),
				collected: {
					stdout: { readFrom: () => ({ text: Buffer.concat(out).toString("utf8"), nextOffset: 0, lossy: false }) },
					stderr: { readFrom: () => ({ text: Buffer.concat(err).toString("utf8"), nextOffset: 0, lossy: false }) },
				},
			};
		},
	};
}

const cfg = { timeoutMs: 30_000, maxDiffLines: 500, maxLogEntries: 50, requireApprovalForWrites: false };
const svc = service();
const ctx = { get: (n) => (n === "subprocess" ? svc : undefined) };
const tool = (name) => defineTools(ctx, cfg).find((t) => t.name === name);

const lab = mkdtempSync(join(tmpdir(), "git-pathbase-"));
const repo = join(lab, "repo");
const sub = join(repo, "sub", "nested");
mkdirSync(sub, { recursive: true });
writeFileSync(join(repo, "root.txt"), "root\n");
writeFileSync(join(sub, "inner.txt"), "inner\n");

const env = {
	...process.env,
	GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "p@x.invalid",
	GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "p@x.invalid",
};
await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
await run("git", ["add", "-A"], { cwd: repo, env });
await run("git", ["commit", "-q", "-m", "seed"], { cwd: repo, env });

// 两处都改，让「根相对」与「工作区相对」能得到不同的路径字符串
writeFileSync(join(repo, "root.txt"), "root changed\n");
writeFileSync(join(sub, "inner.txt"), "inner changed\n");

const execCtx = { agent: { session: { header: { cwd: sub } } }, signal: undefined };

console.log("仓库根:", repo);
console.log("会话 cwd:", sub, "（仓库的子目录）");
console.log();

const status = await tool("git_status").execute({}, execCtx);
console.log("=== git_status，cwd=子目录 ===");
console.log("  modified:", JSON.stringify(status.modified?.map((m) => m.path)));
console.log("  工具发出的 argv:", JSON.stringify(record.at(-1).argv));
console.log("  git 原始 stdout:", JSON.stringify(record.at(-1).stdout));

const diff = await tool("git_diff").execute({}, execCtx);
console.log();
console.log("=== git_diff，cwd=子目录 ===");
console.log("  files:", JSON.stringify(diff.files?.map((f) => f.path)));
console.log("  patch 前 2 行:", JSON.stringify((diff.patch ?? "").split("\n").slice(0, 2)));

const log = await tool("git_log").execute({ limit: 1 }, execCtx);
console.log();
console.log("=== git_log ===");
console.log("  ok:", log.ok, " entries:", log.commits?.length);

// 关键一步：把 git_status 交出的路径**原样喂回去**（模型会这么做），看还认不认得。
const fedBack = status.modified.map((m) => m.path);
const roundTrip = await tool("git_diff").execute({ paths: fedBack }, execCtx);
console.log();
console.log("=== 把上面交出的路径原样喂回 git_diff（模型会这么做）===");
console.log("  喂回去的 paths:", JSON.stringify(fedBack));
console.log("  工具发出的 argv 尾部:", JSON.stringify(record.at(-1).argv.slice(-3)));
console.log("  结果 ok:", roundTrip.ok, " files:", JSON.stringify(roundTrip.files?.map((f) => f.path)));
console.log("  结果 message:", JSON.stringify(roundTrip.message ?? ""));

rmSync(lab, { recursive: true, force: true });
console.log();
console.log("(lab removed)");
