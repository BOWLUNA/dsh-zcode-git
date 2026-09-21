/**
 * Running git through the harness subprocess seam.
 *
 * Two decisions shape this module.
 *
 * **argv, never a shell string.** The harness also exposes `ctx.shell`, whose
 * request is a single command line; using it would drag every argument
 * through a shell parser and require escaping that differs between cmd.exe,
 * PowerShell, and POSIX sh — and that no single regex gets right (cmd.exe
 * still expands `%VAR%` inside double quotes, and `!` under delayed
 * expansion). Handing `ctx.subprocess` an argv array removes the shell from
 * the picture, so a commit message containing `"`, `` ` ``, `$()`, `%PATH%`,
 * a newline, or CJK text arrives at git byte-for-byte. That is the security
 * boundary of this plugin, and it is why the subprocess seam is used rather
 * than `ctx.shell`.
 *
 * **Pinned configuration.** Output must not depend on how the user has
 * configured git. A developer with `color.ui=always`, a custom pager, a
 * `diff.external` handler, or `status.relativePaths=true` would otherwise get
 * different bytes from the same tool call — which is the specific failure
 * this plugin exists to prevent. The pinned set below covers every setting
 * that changes the *shape* of the output this plugin parses, while leaving
 * behavioural settings (`core.autocrlf`, `user.name`, `user.email`, hook
 * configuration) alone: those are the user's intent, not noise.
 *
 * @module dsh-zcode-git/exec
 */

/**
 * Configuration pinned on every invocation.
 *
 * Passed as `-c key=value` immediately after `git`, which outranks every file
 * git would otherwise read for that key.
 */
const PINNED_CONFIG = [
	// Renders color escapes into captured output, which then pollutes every
	// parsed string. `--no-color` is passed too where a command accepts it.
	"-c", "color.ui=false",
	// Launches a pager as a child that we never read, so the command appears to
	// hang until the grace period kills it.
	"-c", "core.pager=cat",
	// C-quotes any path containing a non-ASCII byte, which would turn a CJK
	// filename into `"\346\226\207.txt"`. The `-z` formats avoid quoting
	// already; this covers the formats that do not offer `-z`.
	"-c", "core.quotepath=false",
	// Rewrites every status path relative to the process cwd instead of the
	// repository root, which silently mislabels files when the tool runs in a
	// subdirectory.
	"-c", "status.relativePaths=false",
	// Injects a signature block into log output, breaking record framing.
	"-c", "log.showSignature=false",
	// Changes `git log`'s date rendering. `%aI` is used for the parsed date, but
	// other callers still read the human column.
	"-c", "log.date=default",
	// Suppresses the `a/`…`b/` prefixes, making diff headers ambiguous.
	"-c", "diff.noprefix=false",
	// Replaces `a/`/`b/` with `i/`/`w/`/`c/`, which no parser expects.
	"-c", "diff.mnemonicPrefix=false",
	// Hands the diff to an external program, whose output we would be scraping.
	"-c", "diff.external=",
	// Prints a hint paragraph to stderr on detached HEAD, adding noise to error
	// paths the model reads.
	"-c", "advice.detachedHead=false",
];

/**
 * Environment layered onto every child.
 *
 * The subprocess seam already strips credential-shaped and `DSH_*` names from
 * the inherited environment; these entries add the git-specific hardening that
 * matters for an agent-driven process.
 */
const PINNED_ENV = {
	// Without this, an operation that needs credentials blocks on a terminal
	// prompt that no one can answer, and the only symptom is a timeout. With it,
	// git fails immediately with "could not read Username".
	GIT_TERMINAL_PROMPT: "0",
	// Belt and braces for the same failure: git may invoke an askpass helper
	// instead of prompting when one is configured. An empty value disables it.
	GIT_ASKPASS: "",
	// Read-only commands stop taking `index.lock`, so a status call cannot fail
	// because the user happens to have a rebase paused in another window.
	GIT_OPTIONAL_LOCKS: "0",
	// A pager started by a subprocess we do not read holds the pipe open.
	GIT_PAGER: "cat",
	PAGER: "cat",
};

/** Output ceiling per stream. A `git diff` of a large tree routinely exceeds 1 MiB. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/**
 * Spill-file ceiling. Collected output past the in-memory ceiling is written
 * to a spill file that the seam reports, so a large diff degrades into a
 * readable path rather than a hard failure.
 */
const MAX_SPILL_BYTES = 64 * 1024 * 1024;

/** SIGTERM-to-SIGKILL grace period handed to the seam's managed range. */
const GRACE_MS = 3000;

/**
 * Combine abort sources into one signal without requiring `AbortSignal.any`.
 *
 * `AbortSignal.any` is available in the Node versions this plugin targets, but
 * the harness also runs plugins against older runtimes, and a missing static
 * would be a load-time crash rather than a degraded feature.
 *
 * @param signals - candidate signals, `undefined` entries ignored.
 * @returns one signal, or `undefined` when nothing can abort.
 */
function combineSignals(signals) {
	const usable = signals.filter((signal) => signal !== undefined && signal !== null);
	if (usable.length === 0) return undefined;
	if (usable.length === 1) return usable[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(usable);
	const controller = new AbortController();
	for (const signal of usable) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

/**
 * Run git and collect its output.
 *
 * @param ctx - the plugin context, used to reach the subprocess service.
 * @param argv - arguments *after* `git`; the executable and pinned config are
 *   prepended here so no caller can forget them.
 * @param options - `cwd` selects the repository, `signal` propagates
 *   cancellation, `timeoutMs` bounds the run, `stdin` supplies a body when a
 *   command needs one.
 * @returns the exit facts plus captured stdout/stderr. Non-zero exits resolve;
 *   only infrastructure failures reject, so callers can turn a git failure
 *   into a structured, model-readable result.
 */
export async function runGit(ctx, argv, options = {}) {
	const subprocess = ctx.get("subprocess");
	if (subprocess === undefined) {
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut: false,
			message:
				"the harness subprocess service (ctx.subprocess) is not available in this profile, so git cannot be executed; " +
				"mount @deepseek-ai/dsh-subprocess-local or remove this plugin",
		};
	}

	const { cwd, signal, timeoutMs = 30_000, stdin } = options;
	let timedOut = false;

	// A deadline is expressed as an abort rather than a spec field: the
	// subprocess seam owns process ranges and termination, not wall-clock
	// budgets.
	let timeoutSignal;
	if (typeof timeoutMs === "number" && timeoutMs > 0) {
		timeoutSignal = AbortSignal.timeout(timeoutMs);
		timeoutSignal.addEventListener("abort", () => {
			timedOut = true;
		}, { once: true });
	}

	let handle;
	try {
		handle = subprocess.spawn({
			argv: ["git", ...PINNED_CONFIG, ...argv],
			cwd,
			stdio: {
				stdin: stdin === undefined ? "ignore" : { data: stdin },
				stdout: { maxBytes: MAX_STREAM_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
				stderr: { maxBytes: MAX_STREAM_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
			},
			graceMs: GRACE_MS,
			signal: combineSignals([signal, timeoutSignal]),
			env: PINNED_ENV,
		});
	} catch (error) {
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut,
			message: `could not start git (${describeError(error)}); is git installed and on PATH?`,
		};
	}

	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		// A provider rejection is not a git exit code — it means the process
		// could not be observed, so it must not be reported as a git failure.
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut,
			message: `git could not be run to completion: ${describeError(error)}`,
		};
	}

	const collected = handle.collected;
	if (collected === undefined) {
		return {
			ok: false,
			exitCode: outcome.exitCode,
			signal: outcome.signal,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut,
			message: "the subprocess implementation did not return the collected output streams this plugin requested",
		};
	}

	// `readFrom(0)` is non-consuming for other readers and returns the whole
	// stream; the plugin runs one command per tool call, so offsets never need
	// to advance.
	const stdout = collected.stdout.readFrom(0);
	const stderr = collected.stderr.readFrom(0);
	const truncated = stdout.lossy === true || stderr.lossy === true;

	return {
		ok: outcome.exitCode === 0 && outcome.signal === null && !timedOut,
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout: stdout.text,
		stderr: stderr.text,
		// Reported when the seam spilled the stream to disk so the caller can
		// tell the model where the complete output lives.
		stdoutSpillPath: stdout.spillPath,
		stderrSpillPath: stderr.spillPath,
		truncated,
		timedOut,
		message: timedOut
			? `git did not finish within ${timeoutMs}ms and was terminated; narrow the request (fewer paths, a lower limit) and retry`
			: undefined,
	};
}

/**
 * Turn an unknown thrown value into one line suitable for a model to read.
 *
 * @param error - the caught value.
 * @returns a short description.
 */
function describeError(error) {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "unprintable error";
	}
}

/**
 * Resolve the directory a tool should run in.
 *
 * An omitted `path` means the session working directory, which is the
 * behaviour every other harness tool has. An explicit absolute path is
 * honoured — multi-repository work is normal — and a relative one resolves
 * against the session directory rather than the harness process cwd, which
 * differs between desktop and CLI hosts.
 *
 * @param path - the model-supplied path, possibly absent.
 * @param exec - the tool execution context.
 * @returns an absolute directory path.
 */
export function resolveWorkdir(path, exec) {
	const sessionCwd = exec?.agent?.session?.header?.cwd;
	const fallback = typeof sessionCwd === "string" && sessionCwd.length > 0 ? sessionCwd : process.cwd();
	if (path === undefined || path === null || path === "") return fallback;
	if (typeof path !== "string") return fallback;
	if (/^([A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
	return joinPath(fallback, path);
}

/**
 * Join two path segments without importing `node:path`.
 *
 * Kept local so this module stays import-free and therefore trivially
 * testable; the join is separator-agnostic because the result is only ever
 * handed to the process layer.
 *
 * @param base - the base directory.
 * @param rest - the segment to append.
 * @returns the joined path.
 */
function joinPath(base, rest) {
	const separator = base.includes("\\") || process.platform === "win32" ? "\\" : "/";
	const trimmed = base.endsWith("/") || base.endsWith("\\") ? base.slice(0, -1) : base;
	return `${trimmed}${separator}${rest}`;
}
