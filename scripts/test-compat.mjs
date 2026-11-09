#!/usr/bin/env node
// Loads only the built extension (`pi -ne -e ./dist/index.js`) and checks it registers.
// Without -ne, the installed copy can override these same provider IDs and mask
// a broken working tree. test-startup.mjs separately covers the full installed set.
//
// Two assertions, because they need different things to be true of the machine:
//
//  1. The extension loads. Credential-free, so it runs everywhere including CI,
//     and it is the assertion that matters — a load failure is what breaks a
//     user's pi at startup.
//  2. Both providers list models. Requires working SAP credentials, so it is
//     skipped where there are none (a GitHub runner has none).
//
// The version this replaced ran `pi -e ./index.ts --list-models <provider>` and
// checked only the exit code. pi exits 0 when it prints "No models available",
// so on a runner it asserted nothing at all — which is how it stayed green in
// the publish workflow. Asserting on the model count alone is the opposite
// mistake: correct locally, guaranteed red in CI. Hence the split.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requirePi } from "./resolve-pi.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROVIDERS = ["sap-aicore", "sap-aicore-foundation"];

let failures = 0;
function check(condition, message) {
	console.log(`  ${condition ? "✓" : "❌"} ${message}`);
	if (!condition) failures++;
}

function hasSapCredentials() {
	const authPath = join(homedir(), ".pi/agent/auth.json");
	if (!existsSync(authPath)) return false;
	try {
		// Key presence only — never read or log the credential itself.
		return PROVIDERS.some((p) =>
			Object.hasOwn(JSON.parse(readFileSync(authPath, "utf8")), p),
		);
	} catch {
		return false;
	}
}

const pi = requirePi();
console.log(`pi ${pi.version} (${pi.bin})${pi.bundled ? " [bundled]" : ""}\n`);

const run = (args) =>
	spawnSync(pi.bin, ["-ne", "-e", `${ROOT}/dist/index.js`, ...args, "--offline"], {
		encoding: "utf8",
		timeout: 180_000,
	});

// 1. Load check. The bogus provider makes pi stop straight after extensions are
// loaded, so nothing reaches a model: no network, no tokens, no credentials.
const boot = run(["-p", "ping", "--provider", "__none__", "--model", "__none__"]);
const bootOutput = `${boot.stdout || ""}${boot.stderr || ""}`;
const loadErrors = bootOutput
	.split("\n")
	.filter((line) => /Failed to load extension|Cannot find module/i.test(line));
check(
	loadErrors.length === 0,
	loadErrors.length === 0
		? "extension loads"
		: `extension load failure:\n      ${loadErrors.join("\n      ")}`,
);
// Guards the probe: if pi ever stops reaching this point, the check above would
// pass vacuously on a silent startup — the exact trap the old script fell into.
// Either message proves extension loading completed.
check(
	/Unknown provider|No models available/i.test(bootOutput),
	"pi got past extension loading (probe still valid)",
);

// 2. Registration check, where credentials make it meaningful.
if (hasSapCredentials()) {
	for (const provider of PROVIDERS) {
		const result = run(["--list-models", provider]);
		const output = `${result.stdout || ""}${result.stderr || ""}`;
		const listed = output.split("\n")
			.filter((line) => line.trim().split(/\s+/)[0] === provider).length;
		check(result.status === 0, `${provider}: listing exited ${result.status}`);
		check(listed > 0, `${provider}: ${listed} model(s)`);
		if (listed === 0) console.error(output.trim().split("\n").slice(0, 6).join("\n"));
	}
} else {
	console.log("  – model listing skipped: no SAP credentials on this machine");
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nExtension loads correctly under an isolated -ne -e load");
