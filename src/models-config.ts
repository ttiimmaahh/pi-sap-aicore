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
const ANTHROPIC_THINKING: SapModel["thinkingLevelMap"] = {
	minimal: "1024",
	low: "4096",
	medium: "8192",
	high: "16384",
	xhigh: "31000",
};
const OPENAI_THINKING: SapModel["thinkingLevelMap"] = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

const TENANT_EXTRAS: SapModel[] = [
	{
		id: "anthropic--claude-4.7-opus",
		name: "Claude Opus 4.7",
		reasoning: true,
		tool_call: true,
		temperature: true,
		modalities: {
			input: ["text", "image", "pdf"],
			output: ["text"],
		},
		limit: {
			context: 200_000,
			output: 32_000,
		},
		cost: {
			input: 15,
			output: 75,
			cacheRead: 1.5,
			cacheWrite: 18.75,
		},
		thinkingLevelMap: ANTHROPIC_THINKING,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		tool_call: true,
		temperature: false,
		modalities: {
			input: ["text", "image", "pdf"],
			output: ["text"],
		},
		limit: {
			context: 400_000,
			output: 128_000,
		},
		cost: {
			input: 2.5,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
		},
		thinkingLevelMap: OPENAI_THINKING,
	},
];

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
