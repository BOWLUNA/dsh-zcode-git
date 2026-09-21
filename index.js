/**
 * dsh-tool-git — first-class Git tools for a DeepSeek Harness agent.
 *
 * The harness ships no git tooling, so an agent drives git through `bash`.
 * That has three costs this plugin removes:
 *
 * 1. **Unstable output.** `git status`, `git log`, and `git diff` are shaped by
 *    `color.ui`, `core.pager`, `core.quotepath`, `diff.external`,
 *    `status.relativePaths`, and the user's aliases, so the same call produces
 *    different bytes on different machines. Every command here runs with those
 *    settings pinned and reads a porcelain/`-z`/`%x1f` format.
 * 2. **Shell quoting.** `git commit -m "..."` has to survive cmd.exe,
 *    PowerShell, and POSIX sh, each with different escaping — and none of them
 *    preserve a message containing `%PATH%`, `$(...)`, or a newline by
 *    accident. This plugin builds an argv array, so no shell is involved.
 * 3. **No permission granularity.** In `bash`, `git status` and
 *    `git push --force` are the same tool. Here, mutations are separate tools
 *    that go through the harness approval service.
 *
 * Deliberately absent: `push`, `pull`, `fetch`, `reset --hard`, `clean -fdx`,
 * `rebase`, and global config writes. A tool that can destroy a working tree
 * on one model call is worse than the bash escape hatch it replaces, because
 * the approval prompt is the only thing standing between a mistaken plan and
 * lost work.
 *
 * @module dsh-tool-git
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { runGit, resolveWorkdir } from "./src/exec.js";
import { parseBranches, parseLog, parseNumstat, parseStashList, parseStatus } from "./src/parse.js";
import {
	clampInteger,
	validateBranchName,
	validateCommitMessage,
	validateRepoRelativePaths,
	validateRevision,
} from "./src/validate.js";
import {
	renderBranches,
	renderDiff,
	renderFailure,
	renderLog,
	renderStashList,
	renderStatus,
} from "./src/render.js";

/** Stable plugin identity, matching the package name. */
export const name = "dsh-tool-git";

/** The tool registry is the only hard dependency; everything else is probed. */
export const inject = ["tools"];

/** Plugin configuration. Row-local `config:` in a profile patch overrides these. */
export const Config = z.object({
	timeoutMs: z.number().default(30_000),
	maxDiffLines: z.number().default(500),
	maxLogEntries: z.number().default(50),
	/**
	 * Whether mutations require an approval decision from `ctx.approval`.
	 * Turning this off makes `git_commit` as unguarded as `bash`, which is the
	 * situation this plugin exists to improve — it is exposed only so a headless
	 * profile with no approval service mounted can opt in knowingly.
	 */
	requireApprovalForWrites: z.boolean().default(true),
});

/**
 * Parameter schema for the repository directory.
 *
 * A function rather than a shared object literal. The schema compiler is free
 * to annotate or normalize the spec it is handed, and a single object
 * referenced by six tools would let one tool's compilation mutate another's
 * input — which surfaces as a tool schema the model provider rejects, not as
 * an error at the mutation site.
 */
const pathParam = () => ({
	type: "string",
	description:
		"Directory inside the repository to run in. Defaults to the session working directory; a relative value resolves against it.",
});

/**
 * Parameter schema for repository-relative paths.
 *
 * A function for the same reason as `pathParam`.
 */
const pathsParam = () => ({
	type: "array",
	items: { type: "string" },
	description: "Repository-relative paths to narrow the operation. Absolute paths and \"..\" are rejected.",
});

/** Shared parameter schema helper: a bounded count. */
const limitParam = (description) => ({ type: "integer", description });

/**
 * Build the failure value shared by every tool.
 *
 * Failures resolve rather than throw so the model receives a readable
 * explanation with an exit code it can reason about, instead of a stack trace
 * the harness renders as a generic error. A non-git directory and a missing
 * git binary are the two common cases, and both get a specific hint.
 *
 * @param result - the value returned by `runGit`.
 * @param toolName - the tool reporting the failure.
 * @returns a value matching every tool's failure shape.
 */
function failure(result, toolName) {
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	let message = result.message ?? stderr.trim();
	if (message.length === 0) message = `git exited with code ${result.exitCode}`;
	if (/not a git repository/i.test(stderr)) {
		message += " — this directory is not inside a git work tree; pass `path` pointing at one, or run `git init` first";
	}
	return {
		ok: false,
		exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
		message: `${toolName}: ${message}`,
	};
}

/**
 * Ask the harness approval service before a mutation.
 *
 * Fails closed: with no approval service mounted the mutation is refused
 * rather than allowed, because a silently unguarded `git commit` is exactly
 * the outcome this plugin is meant to prevent.
 *
 * @param ctx - the plugin context.
 * @param exec - the tool execution context; supplies the agent and call id the
 *   approval audit event needs.
 * @param toolName - the tool asking.
 * @param reason - one line explaining what is about to change.
 * @param enabled - from plugin config.
 * @throws when the decision is anything other than a one-time grant.
 */
async function requireApproval(ctx, exec, toolName, reason, enabled) {
	if (!enabled) return;
	const approval = ctx.get("approval");
	if (approval === undefined) {
		throw new Error(
			`${toolName} needs the harness approval service (ctx.approval) to authorise a change to the repository, and none is mounted. ` +
				"Mount @deepseek-ai/dsh-user-approval, or set requireApprovalForWrites: false on this plugin's config to accept unguarded writes.",
		);
	}
	const outcome = await approval.request({
		agent: exec.agent,
		toolName,
		callId: exec.callId,
		reason,
		signal: exec.signal,
	});
	if (outcome !== "allowed-once") {
		throw new Error(`${toolName} was not approved (${outcome}); the repository was left unchanged.`);
	}
}

/**
 * Register every git tool.
 *
 * @param ctx - the plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
	const settings = {
		timeoutMs: config?.timeoutMs ?? 30_000,
		maxDiffLines: config?.maxDiffLines ?? 500,
		maxLogEntries: config?.maxLogEntries ?? 50,
		requireApprovalForWrites: config?.requireApprovalForWrites ?? true,
	};

	for (const definition of defineTools(ctx, settings)) {
		// `defineTool` is not optional here. `ctx.tools.register()` stores the
		// definition verbatim and validates only `output.schema` — it never
		// compiles `parameters`. Registering the raw object therefore leaves the
		// authoring DSL (a bare property map with no top-level `type`) in the
		// payload sent to the model provider, which rejects the entire function
		// schema with `must be a JSON Schema of 'type: "object"', got
		// 'type: null'` — and names only the alphabetically first tool, so the
		// error points at a tool that is not itself at fault.
		const tool = defineTool(definition);
		ctx.effect(() => ctx.tools.register(tool), `dsh-tool-git: ${definition.name}`);
	}
}

/**
 * Build the tool definitions.
 *
 * Separated from `apply` so the definitions can be collected in a test
 * without a live context — registering them is what needs Cordis.
 *
 * @param ctx - the plugin context, closed over by every `execute`.
 * @param settings - resolved plugin configuration.
 * @returns the tool definitions to register.
 */
export function defineTools(ctx, settings) {
	return [
		{
			name: "git_status",
			description:
				"Report the state of a git working tree as structured data: current branch, upstream, ahead/behind counts, and the staged, unstaged, conflicted, and untracked files. " +
				"Prefer this over running `git status` in bash — the output is stable regardless of the user's pager, color, quotepath, or relative-path configuration, and it separates index-side from worktree-side changes.",
			parameters: { path: pathParam() },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						branch: { type: "string" },
						detached: { type: "boolean" },
						oid: { type: "string" },
						upstream: { type: "string" },
						ahead: { type: "integer" },
						behind: { type: "integer" },
						staged: changeListSchema(),
						modified: changeListSchema(),
						conflicted: changeListSchema(),
						untracked: { type: "array", items: { type: "string" } },
						ignored: { type: "array", items: { type: "string" } },
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) => [{ type: "text", text: value.ok === true ? renderStatus(value) : renderFailure(value, "git_status") }],
				presentationMeta: (args, value) => ({
					ok: value.ok === true,
					branch: value.branch,
					changed: (value.staged?.length ?? 0) + (value.modified?.length ?? 0),
				}),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const result = await runGit(ctx, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], {
					cwd: resolveWorkdir(args?.path, exec),
					signal: exec.signal,
					timeoutMs: settings.timeoutMs,
				});
				if (!result.ok) return failure(result, "git_status");
				const state = parseStatus(result.stdout);
				return {
					ok: true,
					branch: state.branch ?? "",
					detached: state.detached,
					oid: state.oid ?? "",
					upstream: state.upstream ?? "",
					ahead: state.ahead,
					behind: state.behind,
					staged: state.staged,
					modified: state.modified,
					conflicted: state.conflicted,
					untracked: state.untracked,
					ignored: state.ignored,
				};
			},
		},

		{
			name: "git_diff",
			description:
				"Show the changes in a git working tree, either unstaged (default) or staged, plus a per-file line summary. " +
				"Prefer this over `git diff` in bash: an external diff driver and the `a/`…`b/` prefix settings would otherwise change the output, and the summary is returned as counts rather than a column-width-dependent histogram.",
			parameters: {
				path: pathParam(),
				staged: { type: "boolean", description: "Show the index (staged) diff instead of the worktree diff. Default false." },
				paths: pathsParam(),
				patch: { type: "boolean", description: "Include the unified diff text. Default true; set false for a summary only." },
				contextLines: { type: "integer", description: "Unified diff context lines (0-20). Default 3." },
				maxLines: limitParam("Maximum patch lines to return (10-5000, default 500). The summary is never truncated."),
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						staged: { type: "boolean" },
						files: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									path: { type: "string" },
									from: { type: "string" },
									added: { type: "integer" },
									deleted: { type: "integer" },
									binary: { type: "boolean" },
								},
							},
						},
						patch: { type: "string" },
						truncated: { type: "boolean" },
						spillPath: { type: "string" },
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) => [{ type: "text", text: value.ok === true ? renderDiff(value) : renderFailure(value, "git_diff") }],
				presentationMeta: (args, value) => ({
					ok: value.ok === true,
					files: value.files?.length ?? 0,
					staged: value.staged === true,
				}),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const pathsError = validateRepoRelativePaths(args?.paths);
				if (pathsError !== null) return { ok: false, exitCode: -1, message: pathsError };
				const cwd = resolveWorkdir(args?.path, exec);
				const paths = args?.paths ?? undefined;
				const common = ["--no-color", "--no-ext-diff", `--unified=${clampInteger(args?.contextLines, 3, 0, 20)}`];
				const scope = args?.staged === true ? ["--cached"] : [];
				const selector = paths === undefined ? [] : ["--", ...paths];

				const numstat = await runGit(ctx, ["diff", "--numstat", "-z", ...common, ...scope, ...selector], {
					cwd,
					signal: exec.signal,
					timeoutMs: settings.timeoutMs,
				});
				if (!numstat.ok) return failure(numstat, "git_diff");
				const files = parseNumstat(numstat.stdout);

				const value = { ok: true, staged: args?.staged === true, files };
				if (args?.patch === false || files.length === 0) return value;

				const patch = await runGit(ctx, ["diff", ...common, ...scope, ...selector], {
					cwd,
					signal: exec.signal,
					timeoutMs: settings.timeoutMs,
				});
				if (!patch.ok) return failure(patch, "git_diff");
				const maxLines = clampInteger(args?.maxLines, settings.maxDiffLines, 10, 5000);
				value.patch = truncateLines(patch.stdout, maxLines);
				value.truncated = patch.truncated === true || value.patch.length < patch.stdout.length;
				if (patch.stdoutSpillPath !== undefined) value.spillPath = patch.stdoutSpillPath;
				return value;
			},
		},

		{
			name: "git_log",
			description:
				"List recent commits with hash, author, ISO date, and subject, optionally limited to paths or a revision range. " +
				"Prefer this over `git log` in bash: the fields arrive as separate values rather than one formatted line, and `log.showSignature`, `log.date`, and color settings cannot reshape them.",
			parameters: {
				path: pathParam(),
				limit: limitParam("Number of commits (1-500, default 50)."),
				paths: pathsParam(),
				revision: {
					type: "string",
					description: "A revision or range to start from, e.g. `HEAD~5` or `main..feature`. Defaults to HEAD.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						commits: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									hash: { type: "string" },
									shortHash: { type: "string" },
									author: { type: "string" },
									date: { type: "string" },
									subject: { type: "string" },
								},
							},
						},
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) => [{ type: "text", text: value.ok === true ? renderLog(value.commits ?? []) : renderFailure(value, "git_log") }],
				presentationMeta: (args, value) => ({ ok: value.ok === true, commits: value.commits?.length ?? 0 }),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const pathsError = validateRepoRelativePaths(args?.paths);
				if (pathsError !== null) return { ok: false, exitCode: -1, message: pathsError };
				const revisionError = args?.revision === undefined ? null : validateRevision(args.revision, "revision");
				if (revisionError !== null) return { ok: false, exitCode: -1, message: revisionError };

				const limit = clampInteger(args?.limit, settings.maxLogEntries, 1, 500);
				const gitArgs = [
					"log",
					"-z",
					`--max-count=${limit}`,
					// `%x1f` (US) separates fields and `-z` separates records, so a
					// subject containing tabs or newlines cannot shift the parse.
					"--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s",
					"--no-color",
				];
				if (args?.revision !== undefined) gitArgs.push(args.revision);
				if (args?.paths !== undefined) gitArgs.push("--", ...args.paths);

				const result = await runGit(ctx, gitArgs, { cwd: resolveWorkdir(args?.path, exec), signal: exec.signal, timeoutMs: settings.timeoutMs });
				if (!result.ok) return failure(result, "git_log");
				return { ok: true, commits: parseLog(result.stdout) };
			},
		},

		{
			name: "git_branch",
			description:
				"List local branches, or create, switch, or delete one. Listing is read-only; the other actions are approved before they run. " +
				"Prefer this over `git branch` in bash: the current-branch marker is returned as a field rather than as a leading `*`, so a branch literally named `*x` is not misread.",
			parameters: {
				path: pathParam(),
				action: {
					type: "string",
					description: "Operation to perform: one of `list`, `create`, `switch`, or `delete`. Defaults to `list`.",
				},
				name: { type: "string", description: "Branch name. Required for create, switch, and delete." },
				startPoint: { type: "string", description: "Commit or ref to branch from, for `create`. Defaults to HEAD." },
				force: { type: "boolean", description: "For `delete`, use -D (discard unmerged commits). Default false; requires approval either way." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						action: { type: "string" },
						branches: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									current: { type: "boolean" },
									name: { type: "string" },
									upstream: { type: "string" },
									commit: { type: "string" },
								},
							},
						},
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) => {
					if (value.ok !== true) return [{ type: "text", text: renderFailure(value, "git_branch") }];
					const body = renderBranches(value.branches ?? []);
					return [{ type: "text", text: value.action === "list" ? body : `${value.action} succeeded\n${body}` }];
				},
				presentationMeta: (args, value) => ({ ok: value.ok === true, action: value.action }),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = args?.action ?? "list";
				const actionError = validateAction(action, BRANCH_ACTIONS);
				if (actionError !== null) return { ok: false, exitCode: -1, message: actionError };
				const cwd = resolveWorkdir(args?.path, exec);
				// `git branch --format` uses the *for-each-ref* escape grammar, in
				// which a hex escape is `%XX`. The `%xXX` form belongs to
				// `git log --format` and is not understood here — git emits the
				// literal text `%x1f` instead of failing, which silently collapses
				// the parse into one unsplit field.
				const listFormat = "--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(objectname:short)";

				if (action !== "list") {
					const nameError = validateBranchName(args?.name ?? "");
					if (nameError !== null) return { ok: false, exitCode: -1, message: nameError };
					const startError = args?.startPoint === undefined ? null : validateRevision(args.startPoint, "startPoint");
					if (startError !== null) return { ok: false, exitCode: -1, message: startError };

					const deleteArgs = action === "delete" ? ["branch", args.force === true ? "-D" : "-d", "--", args.name] : null;
					const mutateArgs =
						action === "create"
							? ["branch", "--", args.name, ...(args?.startPoint === undefined ? [] : [args.startPoint])]
							: action === "switch"
								? ["switch", "--", args.name]
								: deleteArgs;
					if (mutateArgs === null) return { ok: false, exitCode: -1, message: `unsupported action ${JSON.stringify(action)}` };

					const reason =
						action === "delete"
							? `delete the local branch ${args.name}${args.force === true ? " (forced, discarding unmerged commits)" : ""}`
							: action === "create"
								? `create the local branch ${args.name}`
								: `switch the working tree to ${args.name}`;
					await requireApproval(ctx, exec, "git_branch", reason, settings.requireApprovalForWrites);

					const result = await runGit(ctx, mutateArgs, { cwd, signal: exec.signal, timeoutMs: settings.timeoutMs });
					if (!result.ok) return failure(result, "git_branch");
				}

				const listed = await runGit(ctx, ["branch", "--list", listFormat, "--no-color"], {
					cwd,
					signal: exec.signal,
					timeoutMs: settings.timeoutMs,
				});
				if (!listed.ok) return failure(listed, "git_branch");
				return {
					ok: true,
					action,
					// A branch with no upstream omits the field rather than
					// sending `null`: the output schema types `upstream` as a
					// string, and the harness validates the returned value
					// against it, turning a null into INVALID_TOOL_OUTPUT — a
					// failed turn for a successful git call.
					branches: parseBranches(listed.stdout).map((branch) => ({
						current: branch.current,
						name: branch.name,
						commit: branch.commit,
						...(branch.upstream === null ? {} : { upstream: branch.upstream }),
					})),
				};
			},
		},

		{
			name: "git_commit",
			description:
				"Stage the given paths (optional) and create a commit with the given message. Approved before it runs. " +
				"The message is passed as an argv element, so newlines, quotes, backticks, `$(...)`, `%VAR%`, and CJK text are committed byte-for-byte — which is not true of `git commit -m \"...\"` in a shell on Windows.",
			parameters: {
				path: pathParam(),
				message: {
					type: "string",
					description:
						"Commit message — required. May contain newlines for a subject line plus body. Passed to git verbatim, so shell metacharacters are preserved rather than interpreted.",
				},
				paths: pathsParam(),
				amend: { type: "boolean", description: "Amend the previous commit instead of creating one. Rewrites history; approved. Default false." },
				allowEmpty: { type: "boolean", description: "Create the commit even with no staged changes. Default false." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						commit: { type: "string" },
						subject: { type: "string" },
						staged: { type: "array", items: { type: "string" } },
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) =>
					value.ok === true
						? [{ type: "text", text: `committed ${value.commit}: ${value.subject}` }]
						: [{ type: "text", text: renderFailure(value, "git_commit") }],
				presentationMeta: (args, value) => ({ ok: value.ok === true, commit: value.commit }),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const messageError = validateCommitMessage(args?.message);
				if (messageError !== null) return { ok: false, exitCode: -1, message: messageError };
				const pathsError = validateRepoRelativePaths(args?.paths);
				if (pathsError !== null) return { ok: false, exitCode: -1, message: pathsError };

				const cwd = resolveWorkdir(args?.path, exec);
				const paths = args?.paths ?? [];

				const reason =
					args?.amend === true
						? `amend the previous commit in ${cwd} (this rewrites that commit's hash)`
						: `create a commit in ${cwd}${paths.length === 0 ? "" : ` staging ${paths.length} path(s)`}`;
				await requireApproval(ctx, exec, "git_commit", reason, settings.requireApprovalForWrites);

				if (paths.length > 0) {
					const staged = await runGit(ctx, ["add", "--", ...paths], { cwd, signal: exec.signal, timeoutMs: settings.timeoutMs });
					if (!staged.ok) return failure(staged, "git_commit");
				}

				const commitArgs = ["commit", "-m", args.message];
				if (args?.amend === true) commitArgs.push("--amend");
				if (args?.allowEmpty === true) commitArgs.push("--allow-empty");
				const committed = await runGit(ctx, commitArgs, { cwd, signal: exec.signal, timeoutMs: settings.timeoutMs });
				if (!committed.ok) {
					const hint = /nothing to commit|no changes added|nothing added to commit/i.test(committed.stderr)
						? " — nothing was staged; pass `paths` to stage files, or `allowEmpty: true` to commit anyway"
						: "";
					if (hint.length > 0) return { ok: false, exitCode: committed.exitCode ?? -1, message: `${committed.stderr.trim()}${hint}` };
					return failure(committed, "git_commit");
				}

				// The short hash is read back rather than parsed out of `commit`'s
				// output, whose summary line format is not machine-stable.
				const head = await runGit(ctx, ["rev-parse", "--short", "HEAD"], { cwd, signal: exec.signal, timeoutMs: settings.timeoutMs });
				return {
					ok: true,
					commit: head.ok ? head.stdout.trim() : "",
					subject: String(args.message).split("\n")[0],
					...(paths.length === 0 ? {} : { staged: paths }),
				};
			},
		},

		{
			name: "git_stash",
			description:
				"List, save, restore, or drop stashes. Listing is read-only; the other actions are approved before they run. " +
				"Prefer this over `git stash` in bash: an explicit `ref` selects which stash entry is affected, rather than relying on the default `stash@{0}` shifting under the model.",
			parameters: {
				path: pathParam(),
				action: {
					type: "string",
					description: "Operation to perform: one of `list`, `push`, `pop`, `apply`, or `drop`. Defaults to `list`.",
				},
				message: { type: "string", description: "Message for `push`." },
				ref: { type: "string", description: "Which stash entry, e.g. `stash@{1}`. Defaults to `stash@{0}` for pop, apply, and drop." },
				includeUntracked: { type: "boolean", description: "For `push`, also stash untracked files (-u). Default false." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						action: { type: "string" },
						stashes: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									ref: { type: "string" },
									message: { type: "string" },
									date: { type: "string" },
								},
							},
						},
						exitCode: { type: "integer" },
						message: { type: "string" },
					},
				},
				render: (args, value) => {
					if (value.ok !== true) return [{ type: "text", text: renderFailure(value, "git_stash") }];
					const body = renderStashList(value.stashes ?? []);
					return [{ type: "text", text: value.action === "list" ? body : `${value.action} succeeded\n${body}` }];
				},
				presentationMeta: (args, value) => ({ ok: value.ok === true, action: value.action, stashes: value.stashes?.length ?? 0 }),
			},
			timeoutMs: settings.timeoutMs,
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const action = args?.action ?? "list";
				const actionError = validateAction(action, STASH_ACTIONS);
				if (actionError !== null) return { ok: false, exitCode: -1, message: actionError };
				const cwd = resolveWorkdir(args?.path, exec);

				if (action !== "list") {
					const refError = args?.ref === undefined ? null : validateRevision(args.ref, "ref");
					if (refError !== null) return { ok: false, exitCode: -1, message: refError };
					if (action === "push" && args?.message !== undefined) {
						const messageError = validateCommitMessage(args.message);
						if (messageError !== null) return { ok: false, exitCode: -1, message: messageError };
					}
					const target = args?.ref === undefined ? [] : [args.ref];
					const mutateArgs =
						action === "push"
							? ["stash", "push", ...(args?.message === undefined ? [] : ["-m", args.message]), ...(args?.includeUntracked === true ? ["-u"] : [])]
							: ["stash", action, ...target];
					const reason =
						action === "push"
							? "move the current working-tree changes into a stash"
							: action === "drop"
								? `delete ${args?.ref ?? "the most recent stash"} permanently`
								: `restore ${args?.ref ?? "the most recent stash"} into the working tree`;
					await requireApproval(ctx, exec, "git_stash", reason, settings.requireApprovalForWrites);

					const mutated = await runGit(ctx, mutateArgs, { cwd, signal: exec.signal, timeoutMs: settings.timeoutMs });
					if (!mutated.ok) return failure(mutated, "git_stash");
				}

				const listed = await runGit(ctx, ["stash", "list", "-z", "--format=%gd%x1f%gs%x1f%aI", "--no-color"], {
					cwd,
					signal: exec.signal,
					timeoutMs: settings.timeoutMs,
				});
				if (!listed.ok) return failure(listed, "git_stash");
				return { ok: true, action, stashes: parseStashList(listed.stdout) };
			},
		},
	];
}

/** Branch actions `git_branch` accepts. */
const BRANCH_ACTIONS = ["list", "create", "switch", "delete"];

/** Stash actions `git_stash` accepts. */
const STASH_ACTIONS = ["list", "push", "pop", "apply", "drop"];

/**
 * Validate an action selector against its allowed set.
 *
 * The parameter schema does not declare an `enum` for these, deliberately.
 * Tool schemas are forwarded to the model provider verbatim, and at least one
 * provider rejects a whole function schema once it contains `enum`, failing
 * the turn with `schema must be a JSON Schema of 'type: "object"'` — an error
 * that names the tool but not the offending keyword. Enforcing the set here
 * both survives that provider and produces a failure that names every
 * accepted value.
 *
 * @param action - the model-supplied action.
 * @param allowed - the accepted values.
 * @returns an error message, or `null` when acceptable.
 */
function validateAction(action, allowed) {
	if (typeof action !== "string") return `\`action\` must be a string; received ${typeof action}`;
	if (!allowed.includes(action)) {
		return `unsupported action ${JSON.stringify(action)}; expected one of ${allowed.join(", ")}`;
	}
	return null;
}

/** The schema shared by the four change lists `git_status` returns. */
function changeListSchema() {
	return {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				index: { type: "string" },
				worktree: { type: "string" },
				from: { type: "string" },
			},
		},
	};
}

/**
 * Keep the first `maxLines` lines of a patch.
 *
 * Truncation happens on line boundaries so the model never receives half a
 * hunk header, which would look like a valid line to a downstream reader.
 *
 * @param text - the patch.
 * @param maxLines - the ceiling.
 * @returns the possibly-truncated patch.
 */
function truncateLines(text, maxLines) {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n");
}
