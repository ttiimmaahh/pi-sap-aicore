#!/usr/bin/env node
// Offline regression test for sharing the primary provider's stored service
// key with the foundation provider. Makes no network calls and uses an
// isolated temporary auth file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const { readSharedServiceKeyFromStore } = await import(
	pathToFileURL(join(ROOT, "src/auth.ts")).href
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
	console.log("Legacy OAuth credential lookup");
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
		"reads the sap-aicore legacy credential verbatim",
	);
	check(
		readSharedServiceKeyFromStore(authPath)?.includes("literal$secret"),
		"preserves literal dollar signs",
	);

	console.log("Native API-key credential lookup");
	writeFileSync(
		authPath,
		JSON.stringify({ "sap-aicore": { type: "api_key", key: serviceKey } }),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === serviceKey,
		"reads the native Pi 0.81 API-key credential verbatim",
	);

	console.log("Provider isolation");
	writeFileSync(
		authPath,
		JSON.stringify({ "another-provider": { type: "api_key", key: serviceKey } }),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === undefined,
		"does not borrow another provider's credential",
	);

	console.log("Credential validation");
	writeFileSync(
		authPath,
		JSON.stringify({ "sap-aicore": { type: "api_key", key: "not-json" } }),
	);
	check(
		readSharedServiceKeyFromStore(authPath) === undefined,
		"ignores values that are not service-key JSON",
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll checks passed");
