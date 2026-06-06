import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SapModel = {
	id: string;
	name: string;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	modalities: {
		input: ("text" | "image" | "pdf")[];
		output: ("text")[];
	};
	limit: {
		context: number;
		output: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

// Tenant-specific or pre-release models not yet in models.dev's SAP catalog.
// Anything in your SAP tenant that the snapshot doesn't include — add here.
// User-side additions (per-machine, not in source control) should go in
// ~/.pi/agent/models.json using pi's built-in custom-models mechanism.
// SAP orchestration unifies reasoning across providers as
// output_config.effort: "low" | "medium" | "high". See scripts/update-models.mjs
// and stream.ts for the full mapping rationale.
const SAP_EFFORT: SapModel["thinkingLevelMap"] = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

// Currently empty — models.dev's SAP catalog covers everything in our
// tenant. Add entries here when SAP exposes a tenant-only or pre-release
// model that hasn't landed in the public catalog yet, e.g.:
//
//   {
//     id: "some-preview-model",
//     name: "Some Preview Model",
//     reasoning: true,
//     tool_call: true,
//     temperature: true,
//     modalities: { input: ["text"], output: ["text"] },
//     limit: { context: 200_000, output: 32_000 },
//     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
//     thinkingLevelMap: SAP_EFFORT,
//   },
const TENANT_EXTRAS: SapModel[] = [];

function loadSnapshot(): SapModel[] {
	const snapshotPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"models-snapshot.json",
	);
	const raw = readFileSync(snapshotPath, "utf8");
	const parsed = JSON.parse(raw) as { models?: SapModel[] };
	return parsed.models ?? [];
}

const SNAPSHOT_MODELS = loadSnapshot();

// Merge: snapshot first, then extras (extras win on duplicate id).
const byId = new Map<string, SapModel>();
for (const m of SNAPSHOT_MODELS) byId.set(m.id, m);
for (const m of TENANT_EXTRAS) byId.set(m.id, m);

export const MODELS: SapModel[] = Array.from(byId.values()).sort((a, b) =>
	a.id.localeCompare(b.id),
);

// Models exposed via the direct *foundation* (Azure OpenAI) provider, which
// routes through a per-model SAP AI Core deployment instead of orchestration.
// List ONLY ids you've created a foundation-models deployment for — SAP needs
// one deployment per (model, version, resource group), and an id with no
// deployment 404s at call time. Definitions (cost/limits/modalities) are reused
// from the shared snapshot above, so an id only has to be present there.
const FOUNDATION_MODEL_IDS = new Set(["gpt-5.5"]);

export const FOUNDATION_MODELS: SapModel[] = MODELS.filter((m) =>
	FOUNDATION_MODEL_IDS.has(m.id),
);
