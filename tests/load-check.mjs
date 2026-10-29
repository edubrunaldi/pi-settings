// Real load check: uses Pi's own extension loader (jiti), no model calls.
//
//   node tests/load-check.mjs [extension-file ...]
//
// Without arguments it loads every extension in extensions/ (a *.ts file, or a directory holding
// index.ts), so a new extension is covered by `npm run check` without editing this script.
// The loader is resolved from, in order:
//   1. $PI_CODING_AGENT_LOADER (full path to dist/core/extensions/loader.js)
//   2. the @earendil-works/pi-coding-agent resolved from this directory
//   3. the global npm root (npm root -g)
//   4. $PI_BOLT_DIR/node_modules and ~/.pi-bolt/pi-bolt-* (source installs of Pi-Bolt)
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOADER = join("dist", "core", "extensions", "loader.js");
const here = fileURLToPath(new URL(".", import.meta.url));

function resolvedNextToRepo() {
	const require = createRequire(import.meta.url);
	try {
		return dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		return undefined;
	}
}

function nodeModuleRoots() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const roots = [];
	if (process.platform === "win32") {
		if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	} else {
		roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
		if (home) roots.push(join(home, ".npm-global", "lib", "node_modules"));
	}
	for (const entry of (process.env.NODE_PATH ?? "").split(delimiter)) {
		if (entry) roots.push(entry);
	}
	if (home) {
		const base = join(home, ".pi-bolt");
		if (existsSync(base)) {
			for (const dir of readdirSync(base)) {
				if (dir.startsWith("pi-bolt-")) roots.push(join(base, dir, "node_modules"));
			}
		}
	}
	if (process.env.PI_BOLT_DIR) roots.push(join(process.env.PI_BOLT_DIR, "node_modules"));
	return roots;
}

function findLoader() {
	const packages = [
		process.env.PI_CODING_AGENT_PACKAGE,
		resolvedNextToRepo(),
		...nodeModuleRoots().map((root) => join(root, "@earendil-works", "pi-coding-agent")),
	].filter(Boolean);
	for (const dir of packages) {
		const candidate = join(dir, LOADER);
		if (existsSync(candidate)) return candidate;
	}
	if (process.env.PI_CODING_AGENT_LOADER && existsSync(process.env.PI_CODING_AGENT_LOADER)) {
		return process.env.PI_CODING_AGENT_LOADER;
	}
	return undefined;
}

const loaderPath = findLoader();
if (!loaderPath) {
	console.error(
		[
			"Could not find Pi's extension loader (dist/core/extensions/loader.js).",
			"Set PI_CODING_AGENT_LOADER to its full path, or install @earendil-works/pi-coding-agent.",
		].join("\n"),
	);
	process.exit(2);
}

const { loadExtensions } = await import(pathToFileURL(loaderPath).href);

const defaultTarget = fileURLToPath(new URL("../extensions", import.meta.url));

/** Every extension the package manifest exposes: a `*.ts` file or a directory with `index.ts`. */
function discoverTargets() {
	const targets = [];
	for (const entry of readdirSync(defaultTarget)) {
		const full = join(defaultTarget, entry);
		if (entry.endsWith(".ts")) targets.push(full);
		else if (existsSync(join(full, "index.ts")) && statSync(full).isDirectory()) targets.push(join(full, "index.ts"));
	}
	return targets;
}

const targets = process.argv
	.slice(2)
	.map((arg) => fileURLToPath(pathToFileURL(join(here, "..", arg))));
if (!targets.length) targets.push(...discoverTargets());
const result = await loadExtensions(targets, mkdtempSync(join(tmpdir(), "pi-ext-load-")));

console.log(`loader: ${loaderPath}`);
if (result.errors?.length) {
	console.log("errors:", JSON.stringify(result.errors, null, 2));
	process.exitCode = 1;
} else {
	console.log("errors: none");
}
for (const ext of result.extensions) {
	const names = (value) => (value instanceof Map ? [...value.keys()] : Array.isArray(value) ? value : []);
	console.log("loaded:", ext.path);
	console.log("tools:", names(ext.tools).join(", "));
	console.log("commands:", names(ext.commands).join(", "));
	console.log("handlers:", names(ext.handlers).join(", "));
}
