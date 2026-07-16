#!/usr/bin/env node
// Offline regression test for sharing the orchestration provider's stored
// subscription credential with the foundation provider. This makes no network
// calls and uses an isolated temporary auth file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const { readSharedServiceKeyFromStore } = await import(
	pathToFileURL(join(ROOT, "src/stream.ts")).href
);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

const serviceKey = JSON.stringify({
	clientid: "client-id",
	clientsecret: "literal$secret",
	url: "https://auth.example.test",
	serviceurls: { AI_API_URL: "https://api.example.test" },
});
const tempDir = mkdtempSync(join(tmpdir(), "pi-sap-aicore-auth-"));
const authPath = join(tempDir, "auth.json");

try {
	console.log("Shared OAuth credential lookup");
	writeFileSync(
		authPath,
		JSON.stringify({
			"sap-aicore": {
				type: "oauth",
				serviceKey,
				access: "",
				refresh: "",
				expires: Number.MAX_SAFE_INTEGER,
			},
		}),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === serviceKey,
		"reads the sap-aicore OAuth credential verbatim",
	);
	check(
		readSharedServiceKeyFromStore(authPath)?.includes("literal$secret"),
		"preserves literal dollar signs",
	);

	console.log("Provider isolation");
	writeFileSync(
		authPath,
		JSON.stringify({
			"another-provider": {
				type: "oauth",
				serviceKey,
				access: "",
				refresh: "",
				expires: Number.MAX_SAFE_INTEGER,
			},
		}),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === undefined,
		"does not borrow another provider's credential",
	);

	console.log("Credential type validation");
	writeFileSync(
		authPath,
		JSON.stringify({
			"sap-aicore": { type: "api_key", key: serviceKey },
		}),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === undefined,
		"ignores non-OAuth credentials",
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll checks passed");
