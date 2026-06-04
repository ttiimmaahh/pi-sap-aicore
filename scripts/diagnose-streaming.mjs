// THROWAWAY DIAGNOSTIC — safe to delete. Not wired into the extension.
//
// Proves the SAP-side hypothesis behind the gpt-5.5 fallback: that SAP AI Core
// *orchestration* refuses to STREAM the model (400 "Streaming is not supported
// for this model") even though the same model answers fine NON-streaming via
// chatCompletion(). If the blocking call below succeeds, the auto-detect
// fallback in src/stream.ts is the correct fix.
//
// Usage (makes ONE real, billed call per leg):
//   AICORE_SERVICE_KEY='<your service-key JSON>' node scripts/diagnose-streaming.mjs
//   # optional: AICORE_RESOURCE_GROUP=<group>   MODEL=gpt-5.5
//
// Run it from the repo root so Node resolves @sap-ai-sdk/orchestration from
// this project's node_modules.

import { OrchestrationClient } from "@sap-ai-sdk/orchestration";

const MODEL = process.env.MODEL ?? "gpt-5.5";

const raw = process.env.AICORE_SERVICE_KEY;
if (!raw) {
	console.error(
		"Set AICORE_SERVICE_KEY to your SAP BTP service-key JSON, e.g.\n" +
			"  AICORE_SERVICE_KEY='{...}' node scripts/diagnose-streaming.mjs",
	);
	process.exit(2);
}

// Mirror the extension's resource-group precedence: env override, then a
// non-standard `resourceGroup` baked into the key, else SAP's "default".
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

function makeClient() {
	return new OrchestrationClient(
		{
			promptTemplating: {
				model: { name: MODEL, params: { max_tokens: 64 } },
				prompt: { template: [] },
			},
		},
		resourceGroup ? { resourceGroup } : undefined,
	);
}

const messages = [{ role: "user", content: "Reply with exactly: pong" }];

console.log(`Model: ${MODEL}  resourceGroup: ${resourceGroup ?? "(default)"}\n`);

// Leg 1: streaming — expected to FAIL for a streaming-gated model like gpt-5.5.
console.log("[1/2] client.stream() ...");
try {
	const response = await makeClient().stream({ messages }, undefined, {
		promptTemplating: { include_usage: true },
	});
	let text = "";
	for await (const chunk of response.stream) {
		text += chunk.getDeltaContent() ?? "";
	}
	console.log(`  STREAMING OK — got: ${JSON.stringify(text)}`);
	console.log("  → This model already streams via orchestration; no fallback needed.\n");
} catch (error) {
	const msg = error?.response?.data
		? JSON.stringify(error.response.data)
		: (error?.message ?? String(error));
	const isStreamGate = /streaming is not supported/i.test(
		`${error?.message ?? ""} ${msg}`,
	);
	console.log(`  STREAMING FAILED — ${msg}`);
	console.log(
		isStreamGate
			? "  → Confirms the streaming-gate. Checking non-streaming next.\n"
			: "  → Different failure (not the streaming gate). Read the message above.\n",
	);
}

// Leg 2: non-streaming — expected to SUCCEED, proving the fallback is valid.
console.log("[2/2] client.chatCompletion() ...");
try {
	const response = await makeClient().chatCompletion({ messages });
	console.log(`  NON-STREAMING OK — got: ${JSON.stringify(response.getContent())}`);
	console.log("  → Fallback is valid: the extension's auto-detect path will work.\n");
} catch (error) {
	const msg = error?.response?.data
		? JSON.stringify(error.response.data)
		: (error?.message ?? String(error));
	console.log(`  NON-STREAMING FAILED — ${msg}`);
	console.log("  → This model is broken via orchestration entirely (not just streaming).\n");
	process.exit(1);
}
