#!/usr/bin/env node

import { createSapModelCatalogController } from "../src/model-catalog-controller.ts";
import {
	FOUNDATION_PROVIDER_ID,
	SAP_FOUNDATION_API,
	SAP_ORCHESTRATION_API,
	createSapProviders,
} from "../src/providers.ts";

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

const model = (id) => ({
	id,
	name: id,
	reasoning: true,
	tool_call: true,
	temperature: false,
	modalities: { input: ["text", "image"], output: ["text"] },
	limit: { context: 128000, output: 16384 },
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { high: "high" },
});

const catalog = {
	models: [model("gpt-5.5"), model("gpt-5.6")],
	foundationModelIds: new Set(["gpt-5.5"]),
	sources: { packaged: { models: [] } },
};
const controller = createSapModelCatalogController({ loadCatalog: () => catalog });
const providers = createSapProviders(controller, {
	readSharedServiceKey: () => serviceKey,
});

console.log("Complete provider registration");
for (const provider of [providers.orchestration, providers.foundation]) {
	check(typeof provider.id === "string", `${provider.name} has an id`);
	check(typeof provider.getModels === "function", `${provider.name} exposes getModels`);
	check(typeof provider.refreshModels === "function", `${provider.name} exposes refreshModels`);
	check(typeof provider.stream === "function", `${provider.name} exposes stream`);
	check(typeof provider.streamSimple === "function", `${provider.name} exposes streamSimple`);
}

const orchestrationModels = providers.orchestration.getModels();
const foundationModels = providers.foundation.getModels();
check(orchestrationModels.length === 2, "orchestration exposes the full catalog");
check(foundationModels.length === 1, "foundation exposes only enabled model ids");
check(
	orchestrationModels.every(
		(entry) => entry.provider === "sap-aicore" && entry.api === SAP_ORCHESTRATION_API,
	),
	"orchestration models carry native provider/API metadata",
);
check(
	foundationModels.every(
		(entry) => entry.provider === FOUNDATION_PROVIDER_ID && entry.api === SAP_FOUNDATION_API,
	),
	"foundation models carry native provider/API metadata",
);

console.log("Native and legacy authentication");
const apiKeyAuth = providers.orchestration.auth.apiKey;
const oauthAuth = providers.orchestration.auth.oauth;
check(!!apiKeyAuth?.login, "primary provider offers native API-key login");
check(!!oauthAuth, "primary provider retains legacy OAuth credentials");
check(!providers.foundation.auth.oauth, "foundation does not duplicate OAuth login");
check(
	!providers.foundation.auth.apiKey?.login,
	"raw foundation provider relies on ambient/shared auth instead of a custom login",
);

const entered = await apiKeyAuth.login({
	prompt: async () => serviceKey,
	notify: () => {},
});
check(entered.type === "api_key" && entered.key === serviceKey, "native login preserves literal dollars");

const noEnvContext = {
	env: async () => undefined,
	fileExists: async () => false,
};
const resolvedStored = await apiKeyAuth.resolve({ ctx: noEnvContext, credential: entered });
check(resolvedStored?.auth.apiKey === serviceKey, "native stored credential resolves verbatim");

try {
	await apiKeyAuth.resolve({
		ctx: { ...noEnvContext, env: async () => serviceKey },
		credential: { type: "api_key", key: "not-json" },
	});
	check(false, "malformed stored credentials fail instead of falling back to ambient auth");
} catch {
	check(true, "malformed stored credentials fail instead of falling back to ambient auth");
}

const resolvedLegacy = await oauthAuth.toAuth({
	type: "oauth",
	serviceKey,
	access: "",
	refresh: "",
	expires: Number.MAX_SAFE_INTEGER,
});
check(resolvedLegacy.apiKey === serviceKey, "legacy OAuth credential resolves without re-login");

const resolvedFoundation = await providers.foundation.auth.apiKey.resolve({
	ctx: noEnvContext,
});
check(resolvedFoundation?.auth.apiKey === serviceKey, "foundation shares the primary credential");

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll native provider checks passed");
