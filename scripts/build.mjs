#!/usr/bin/env node
// Bundles the extension and the SAP SDKs into dist/index.js, the entry pi loads.
//
// The SDKs pull in CommonJS packages (logform -> fecha) that pi's standalone Bun
// runtime cannot resolve from node_modules. Bundling settles those imports at
// build time, so the same file runs on Node and on Bun.

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = join(ROOT, "dist");
const OUTFILE = "dist/index.js";

// pi provides these at runtime; a bundled copy would duplicate its classes and
// registries (see "Declare dependencies" in pi's packages docs).
const HOST_PACKAGES = /^@earendil-works\//;

// Under SAP's Developer License, which bars making them available to third
// parties, so they are installed from npm instead of shipped in our tarball.
const EXTERNAL_PACKAGES = ["@sap/xsenv", "@sap/xssec"];

// Requires that sit in a try/catch in the bundled code, so failing is harmless.
const OPTIONAL_IMPORTS = new Set(["supports-color"]); // debug's color detection

const RESTRICTED_LICENSE = /SAP DEVELOPER|SEE LICENSE/i;

const banner = readFileSync(join(ROOT, "scripts/bundle-banner.js"), "utf8").replace(
	"__EXTERNAL_PACKAGES__",
	JSON.stringify(EXTERNAL_PACKAGES),
);

function packageDirOf(input) {
	const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
	return match?.[1];
}

function thirdPartyNotices(inputs) {
	const dirs = [...new Set(Object.keys(inputs).map(packageDirOf).filter(Boolean))];
	const packages = dirs.map((dir) => {
		const full = join(ROOT, dir);
		const manifest = JSON.parse(readFileSync(join(full, "package.json"), "utf8"));
		const texts = readdirSync(full)
			.filter((name) => /^(licen[cs]e|notice)/i.test(name))
			.map((name) => readFileSync(join(full, name), "utf8").trim());
		return { id: `${manifest.name}@${manifest.version}`, license: manifest.license, texts };
	});
	const restricted = packages.filter((p) => RESTRICTED_LICENSE.test(p.license ?? ""));
	if (restricted.length > 0) {
		throw new Error(
			`Restricted license in bundle: ${restricted.map((p) => p.id).join(", ")}. ` +
				"Review its terms and add it to EXTERNAL_PACKAGES if it cannot be redistributed.",
		);
	}
	packages.sort((a, b) => a.id.localeCompare(b.id));
	const body = packages
		.map((p) => [`${p.id} (${p.license ?? "license not declared"})`, ...p.texts].join("\n\n"))
		.join(`\n\n${"-".repeat(72)}\n\n`);
	return { text: `Third-party software bundled in dist/index.js\n\n${body}\n`, count: packages.length };
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);

const result = await build({
	absWorkingDir: ROOT,
	entryPoints: ["index.ts"],
	outfile: OUTFILE,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["@earendil-works/*", ...EXTERNAL_PACKAGES],
	define: { "Error.captureStackTrace": "__safeCaptureStackTrace" },
	banner: { js: banner },
	legalComments: "none",
	logLevel: "warning",
	metafile: true,
});

// Anything left external has to resolve at runtime, which is the failure this
// build exists to remove.
const unexpected = result.metafile.outputs[OUTFILE].imports
	.filter((i) => i.external && !isBuiltin(i.path))
	.filter((i) => !HOST_PACKAGES.test(i.path) && !OPTIONAL_IMPORTS.has(i.path))
	.filter((i) => !EXTERNAL_PACKAGES.includes(i.path))
	.map((i) => i.path);
if (unexpected.length > 0) {
	throw new Error(`Unbundled runtime imports: ${[...new Set(unexpected)].join(", ")}`);
}

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const undeclared = EXTERNAL_PACKAGES.filter((name) => !manifest.dependencies?.[name]);
if (undeclared.length > 0) {
	throw new Error(`External packages missing from dependencies: ${undeclared.join(", ")}`);
}

// model-catalog.ts reads the snapshot from next to its own module.
copyFileSync(join(ROOT, "src/models-snapshot.json"), join(DIST, "models-snapshot.json"));

const notices = thirdPartyNotices(result.metafile.inputs);
writeFileSync(join(DIST, "THIRD-PARTY-NOTICES.txt"), notices.text);

if (!existsSync(join(ROOT, OUTFILE))) throw new Error(`${OUTFILE} was not written`);
const mb = (result.metafile.outputs[OUTFILE].bytes / 1024 / 1024).toFixed(1);
console.log(`built ${OUTFILE} (${mb} MB, ${notices.count} bundled packages)`);
