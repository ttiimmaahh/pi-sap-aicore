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

// Defensive cap on how many tokens we ever ask Anthropic to "think" with.
// Each pi level maps to a budget; anything exceeding the model's max output
// is clamped down. Anthropic's API minimum is 1024.
const ANTHROPIC_THINKING_BUDGETS = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
};

const OPENAI_THINKING_LEVELS = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

function familyFor(id) {
	if (id.startsWith("anthropic--")) return "anthropic";
	if (id.startsWith("gpt-")) return "openai";
	if (id.startsWith("gemini-")) return "gemini";
	return "other";
}

function thinkingMapFor(family, maxOutput) {
	if (family === "anthropic") {
		// Clamp xhigh below max_output so the response itself has room.
		const out = {};
		for (const [level, budget] of Object.entries(ANTHROPIC_THINKING_BUDGETS)) {
			out[level] = String(Math.min(budget, Math.max(1024, maxOutput - 1024)));
		}
		return out;
	}
	if (family === "openai") return { ...OPENAI_THINKING_LEVELS };
	return undefined;
}

function adapt(model) {
	const family = familyFor(model.id);
	const input = (model.modalities?.input ?? ["text"]).filter((m) =>
		["text", "image", "pdf"].includes(m),
	);
	const adapted = {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: !!model.reasoning,
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
	const thinkingMap = model.reasoning ? thinkingMapFor(family, adapted.limit.output) : undefined;
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
