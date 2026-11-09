// Runtime prelude for dist/index.js, prepended by scripts/build.mjs, which also
// fills in the external package list below.
import { createRequire as __createRequire } from "node:module";
import { existsSync as __existsSync, readFileSync as __readFileSync, statSync as __statSync } from "node:fs";
import { dirname as __dirname_, join as __join, resolve as __resolve } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";

// Bundled packages call Error.captureStackTrace on old-style error objects. While
// Babel is loaded, which pi does whenever any extension is uncached, Bun throws on
// those objects, so the build routes every call here.
function __safeCaptureStackTrace(target, constructorOpt) {
	try {
		Error.captureStackTrace(target, constructorOpt);
	} catch {
		target.stack = new Error().stack;
	}
}

// esbuild's CommonJS shim calls whatever `require` is in scope. Under pi's loader
// that is jiti's interop wrapper, and a class extending a built-in fetched through
// it loses its own methods. `var` because jiti's wrapper may also bind `require`.
const __nativeRequire = __createRequire(import.meta.url);
const __Module = __nativeRequire("node:module");
const __externalPackages = new Set(__EXTERNAL_PACKAGES__);

function __packageEntry(name, fromDir) {
	for (let dir = fromDir; ; dir = __dirname_(dir)) {
		const packageDir = __join(dir, "node_modules", name);
		const manifestPath = __join(packageDir, "package.json");
		if (__existsSync(manifestPath)) {
			const manifest = JSON.parse(__readFileSync(manifestPath, "utf8"));
			const pick = (target) =>
				typeof target === "string"
					? target
					: target && (pick(target.node) ?? pick(target.require) ?? pick(target.default));
			const root = manifest.exports?.["."] ?? manifest.exports;
			const base = __resolve(packageDir, pick(root) ?? manifest.main ?? "index.js");
			for (const candidate of [base, `${base}.js`, __join(base, "index.js")]) {
				if (__existsSync(candidate) && __statSync(candidate).isFile()) return candidate;
			}
		}
		if (dir === __dirname_(dir)) return undefined;
	}
}

function __isBarePackage(request) {
	if (/^[./]/.test(request) || __Module.isBuiltin(request)) return false;
	return request.split("/").length === (request.startsWith("@") ? 2 : 1);
}

// Pi's standalone Bun runtime cannot resolve a package through its package.json
// entry point, so external packages and their dependencies are located here. The
// hook is only installed while one of them loads.
function __requireExternal(name) {
	const entry = __packageEntry(name, __dirname_(__fileURLToPath(import.meta.url)));
	if (!entry) throw new Error(`Cannot find module '${name}'`);
	const resolveFilename = __Module._resolveFilename;
	__Module._resolveFilename = function (request, parent, ...rest) {
		try {
			return resolveFilename.call(this, request, parent, ...rest);
		} catch (error) {
			const found =
				__isBarePackage(request) && parent?.filename
					? __packageEntry(request, __dirname_(parent.filename))
					: undefined;
			if (found) return found;
			throw error;
		}
	};
	try {
		return __nativeRequire(entry);
	} finally {
		__Module._resolveFilename = resolveFilename;
	}
}

var require = Object.assign(
	(id) => (__externalPackages.has(id) ? __requireExternal(id) : __nativeRequire(id)),
	__nativeRequire,
);
