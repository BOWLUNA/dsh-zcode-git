#!/usr/bin/env node
/**
 * Make the harness peer packages resolvable from the repository root.
 *
 * The tests import `@deepseek-ai/dsh-tools`, which is a peer dependency: the
 * harness supplies it, the plugin never ships it. That is the right contract
 * for a plugin, but it means neither `npm test` locally nor CI can resolve the
 * import from a fresh clone.
 *
 * `@deepseek-ai/dsh-tools` is not published on npm as a matching version — only
 * an unrelated `0.0.1-rc.1` — so it cannot be installed directly. It *is*
 * present inside `@deepseek-ai/dsh`'s own dependency tree, and it is also in
 * whatever harness install is on this machine. This script finds either and
 * links it into `node_modules/@deepseek-ai/`, so a repository checkout can run
 * its own suite.
 *
 * Idempotent: an existing link is left alone, and an existing real directory is
 * never replaced.
 *
 * Run: node tools/link-harness-peers.mjs
 *      node tools/link-harness-peers.mjs --print   # report what it would do
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = join(REPO, "node_modules", "@deepseek-ai");
const PEERS = ["dsh-tools", "schemastery", "cordis"];
const printOnly = process.argv.includes("--print");

/**
 * Where to look for a harness to link peers out of.
 *
 * `DSH_INSTALL` is the supported way to point at one, and it is the **only**
 * Windows source on purpose. This file previously carried a literal path to one
 * developer's harness, which is worse than useless in a published package: it
 * goes stale the moment that harness moves (it moved once, on 2026-09-21), and
 * every reader silently inherits a machine-specific guess. A probe that misses
 * costs one `stat`; a literal that is wrong costs a confusing failure.
 *
 * So: set `DSH_INSTALL` to the harness root (the directory with
 * `node_modules/@deepseek-ai/dsh` under it — the desktop harness at
 * `<install>/harness`, or the package directory of a global install). On Linux
 * the conventional `~/.dsh/profiles` is also probed, because that mirror is a
 * documented layout rather than a machine-specific path.
 *
 * If nothing is found the error below says exactly what to set.
 */
function harnessRoots() {
	const roots = [];
	if (process.env.DSH_INSTALL !== undefined) roots.push(process.env.DSH_INSTALL);
	if (process.platform !== "win32") {
		roots.push(join(process.env.HOME ?? "", ".dsh", "profiles"));
	}
	return roots.filter((root) => root.length > 0);
}

/**
 * Find a directory that actually contains the given scoped package.
 *
 * @param name - package name without the scope, e.g. `dsh-tools`.
 * @returns the containing `@deepseek-ai` directory, or `undefined`.
 */
function findScope(name) {
	// 1. Inside the harness package's own dependency tree (the CI layout, where
	//    `npm install @deepseek-ai/dsh` nests its dependencies).
	const nested = join(REPO, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", name);
	if (existsSync(nested)) return dirname(nested);

	// 2. This repository's own install, at the level npm hoists to. This is the
	//    layout a checkout gets from a plain `npm install` once the harness is a
	//    devDependency, and it is where a peer of a `link:`-mounted plugin is
	//    resolved from in the first place.
	//
	//    It is listed before any external harness on purpose. When a plugin is
	//    installed with `link:`, node resolves bare imports from the *plugin's
	//    real path*, so these links are what actually decide whether
	//    `@deepseek-ai/cosmokit` resolves. Preferring a shared, mutable harness
	//    over the repository's own tree means a change made elsewhere — to a
	//    directory this repository does not own — silently breaks the boot here.
	const own = join(REPO, "node_modules", "@deepseek-ai", name);
	if (existsSync(own)) return dirname(own);

	// 3. An external harness (the local-development layout), via `DSH_INSTALL`
	//    or the conventional locations.
	for (const root of harnessRoots()) {
		if (!existsSync(root)) continue;
		const candidates = [join(root, "node_modules", "@deepseek-ai", name)];
		try {
			for (const entry of readdirSync(root)) {
				candidates.push(join(root, entry, "node_modules", "@deepseek-ai", name));
				candidates.push(join(root, entry, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", name));
			}
		} catch {
			// A missing or unreadable root is simply not a candidate.
		}
		const hit = candidates.find((candidate) => existsSync(candidate));
		if (hit !== undefined) return dirname(hit);
	}
	return undefined;
}

mkdirSync(SCOPE, { recursive: true });
let linked = 0;
let skipped = 0;

for (const name of PEERS) {
	const target = join(SCOPE, name);
	if (existsSync(target)) {
		skipped += 1;
		continue;
	}
	const scope = findScope(name);
	if (scope === undefined) {
		console.warn(`· ${name}: not found in any harness install — schema-dependent tests will fail to import.`);
		console.warn("  Set DSH_INSTALL to the harness app directory, or run `npm install --no-save @deepseek-ai/dsh`.");
		continue;
	}
	const source = join(scope, name);
	if (printOnly) {
		console.log(`would link ${source} -> ${target}`);
		continue;
	}
	symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
	console.log(`✓ linked @deepseek-ai/${name}`);
	linked += 1;
}

console.log(`harness peers: ${String(linked)} linked, ${String(skipped)} already present`);
