// DIAGNOSTIC — lists the models your SAP AI Core tenant *actually* deploys.
//
// Hits the authoritative endpoint GET /v2/lm/scenarios/foundation-models/models
// (SDK: ScenarioApi.scenarioQueryModels) and diffs it against
// src/models-snapshot.json. This is the ground truth that models.dev's catalog
// only approximates — use it to spot phantom models (in the snapshot but not in
// the tenant, e.g. gpt-5.5) and missing ones (deployed but absent from our
// snapshot, e.g. gpt-5.2 / gpt-5.4-nano).
//
// Usage (one read-only, unbilled API call):
//   AICORE_SERVICE_KEY='<your service-key JSON>' node scripts/list-sap-models.mjs
//   # optional: AICORE_RESOURCE_GROUP=<group>
//
// Run from the repo root so Node resolves @sap-ai-sdk/ai-api from node_modules.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ScenarioApi } from "@sap-ai-sdk/ai-api";

const raw = process.env.AICORE_SERVICE_KEY;
if (!raw) {
	console.error(
		"Set AICORE_SERVICE_KEY to your SAP BTP service-key JSON, e.g.\n" +
			"  AICORE_SERVICE_KEY='{...}' node scripts/list-sap-models.mjs",
	);
	process.exit(2);
}

// Resource-group precedence mirrors the extension and diagnose-streaming.mjs:
// env override, then a non-standard `resourceGroup` baked into the key, else
// SAP's "default".
let resourceGroup = process.env.AICORE_RESOURCE_GROUP?.trim() || undefined;
if (!resourceGroup) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.resourceGroup === "string") {
			resourceGroup = parsed.resourceGroup;
		}
	} catch {
		// The SDK validates the key shape itself; ignore parse noise here.
	}
}
resourceGroup ??= "default";

function snapshotIds() {
	const path = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"src",
		"models-snapshot.json",
	);
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	return new Set((parsed.models ?? []).map((m) => m.id));
}

console.log(
	`Querying foundation-models scenario  resourceGroup: ${resourceGroup}\n`,
);

const response = await ScenarioApi.scenarioQueryModels("foundation-models", {
	"AI-Resource-Group": resourceGroup,
}).execute();

const resources = response?.resources ?? [];
const tenant = new Set(resources.map((r) => r.model));
const tenantSorted = [...tenant].sort();

console.log(`Tenant reports ${response?.count ?? resources.length} models:\n`);
for (const r of resources.sort((a, b) => a.model.localeCompare(b.model))) {
	const extras = [r.provider, r.accessType].filter(Boolean).join(", ");
	console.log(`  ${r.model}${extras ? `  (${extras})` : ""}`);
}

console.log("\n--- gpt-5.5 specifically ---");
console.log(
	tenant.has("gpt-5.5")
		? "  PRESENT — SAP does deploy gpt-5.5 after all."
		: "  ABSENT — gpt-5.5 is not in the tenant's model list (matches the 400).",
);

const snap = snapshotIds();
const phantom = [...snap].filter((id) => !tenant.has(id)).sort();
const missing = tenantSorted.filter((id) => !snap.has(id));

console.log("\n--- snapshot vs. tenant ---");
console.log(
	`  PHANTOM (in snapshot, NOT in tenant → will 400): ${phantom.length ? phantom.join(", ") : "none"}`,
);
console.log(
	`  MISSING (in tenant, NOT in snapshot → unselectable): ${missing.length ? missing.join(", ") : "none"}`,
);
