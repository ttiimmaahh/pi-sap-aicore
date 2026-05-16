#!/usr/bin/env node
/**
 * Refresh src/models-snapshot.json from models.dev's SAP AI Core entry.
 * Run: npm run update-models
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "models-snapshot.json");
const SOURCE = "https://models.dev/api.json";

// SAP orchestration uses provider-native reasoning shapes (see
// src/stream.ts:reasoningParams). What's *common* across providers is the
// effort tier — pi has 5 above-off levels, the provider tiers are 3
// (low/medium/high). Fold minimal→low and xhigh→high so every pi level
// still does something (rather than dropping minimal/xhigh silently).
const SAP_EFFORT_BY_LEVEL = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

function thinkingMapFor(reasoning) {
	if (!reasoning) return undefined;
	return { ...SAP_EFFORT_BY_LEVEL };
}

// Per-family reasoning support. SAP orchestration accepts Anthropic's
// `thinking + output_config` and OpenAI's `reasoning_effort`. Gemini's
// shape via SAP is undocumented — we leave reasoning OFF for gemini-* so
// pi's Shift+Tab cycle doesn't silently no-op. If/when SAP confirms the
// passthrough (likely `thinking_config.thinking_budget`), wire it in
// src/stream.ts:reasoningParams and re-enable here.
function supportsReasoning(model) {
	if (!model.reasoning) return false;
	if (model.id.startsWith("gemini-")) return false;
	return true;
}

function adapt(model) {
	const input = (model.modalities?.input ?? ["text"]).filter((m) =>
		["text", "image", "pdf"].includes(m),
	);
	const reasoning = supportsReasoning(model);
	const adapted = {
		id: model.id,
		name: model.name ?? model.id,
		reasoning,
		tool_call: !!model.tool_call,
		temperature: model.temperature !== false,
		modalities: {
			input,
			output: ["text"],
		},
		limit: {
			context: model.limit?.context ?? 0,
			output: model.limit?.output ?? 0,
		},
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
	};
	const thinkingMap = thinkingMapFor(reasoning);
	if (thinkingMap) adapted.thinkingLevelMap = thinkingMap;
	return adapted;
}

function shouldInclude(id) {
	return (
		id.startsWith("anthropic--claude-4") ||
		id.startsWith("gpt-5") ||
		id.startsWith("gemini-2.5")
	);
}

const res = await fetch(SOURCE);
if (!res.ok) {
	console.error(`Failed to fetch ${SOURCE}: ${res.status} ${res.statusText}`);
	process.exit(1);
}
const all = await res.json();
const sapModels = all["sap-ai-core"]?.models ?? {};
const adapted = Object.values(sapModels)
	.filter((m) => shouldInclude(m.id))
	.map(adapt)
	.sort((a, b) => a.id.localeCompare(b.id));

const snapshot = {
	source: SOURCE,
	fetchedAt: new Date().toISOString(),
	count: adapted.length,
	models: adapted,
};

writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${adapted.length} models to ${OUT}`);
for (const m of adapted) {
	console.log(`  ${m.id}  ctx=${m.limit.context} out=${m.limit.output} reasoning=${m.reasoning}`);
}
