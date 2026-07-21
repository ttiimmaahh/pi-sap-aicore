import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type SapModel = {
	id: string;
	name: string;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	modalities: {
		input: ("text" | "image" | "pdf")[];
		output: "text"[];
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

export type SapModelOverlay = {
	models?: SapModel[];
	overrides?: Record<string, Partial<SapModel>>;
	exclude?: string[];
	foundation?: {
		enabledModelIds?: string[];
	};
};

export type SapModelsSnapshot = {
	source?: string;
	fetchedAt?: string;
	count?: number;
	models?: SapModel[];
};

export const MODELS_DEV_SOURCE = "https://models.dev/api.json";
export const DEFAULT_FOUNDATION_MODEL_IDS = ["gpt-5.5"] as const;

const SAP_EFFORT_BY_LEVEL: SapModel["thinkingLevelMap"] = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

function packageDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

export function sapModelsDir(): string {
	return join(getAgentDir(), "pi-sap-aicore");
}

export function userOverlayPath(): string {
	return join(sapModelsDir(), "models.json");
}

export function userCachePath(): string {
	return join(sapModelsDir(), "models-cache.json");
}

export function packagedSnapshotPath(): string {
	return join(packageDir(), "models-snapshot.json");
}

export function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		console.warn(
			`Ignoring invalid JSON file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function readUserJsonFile<T>(path: string, label: string): T | undefined {
	try {
		return readJsonFile<T>(path);
	} catch (error) {
		console.warn(
			`Ignoring invalid pi-sap-aicore ${label} file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function loadPackagedSnapshot(): SapModelsSnapshot {
	return (
		readJsonFile<SapModelsSnapshot>(packagedSnapshotPath()) ?? { models: [] }
	);
}

export function loadUserCache(): SapModelsSnapshot | undefined {
	return readUserJsonFile<SapModelsSnapshot>(userCachePath(), "cache");
}

export function loadUserOverlay(): SapModelOverlay | undefined {
	const overlay = readUserJsonFile<SapModelOverlay>(
		userOverlayPath(),
		"overlay",
	);
	if (!overlay) return undefined;
	return {
		...overlay,
		models: overlay.models ?? [],
		overrides: overlay.overrides ?? {},
		exclude: overlay.exclude ?? [],
		foundation: {
			...overlay.foundation,
			enabledModelIds: overlay.foundation?.enabledModelIds ?? [],
		},
	};
}

function mergeModel(base: SapModel, override: Partial<SapModel>): SapModel {
	return {
		...base,
		...override,
		modalities: override.modalities
			? {
					input: override.modalities.input ?? base.modalities.input,
					output: override.modalities.output ?? base.modalities.output,
				}
			: base.modalities,
		limit: override.limit ? { ...base.limit, ...override.limit } : base.limit,
		cost: override.cost ? { ...base.cost, ...override.cost } : base.cost,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...base.thinkingLevelMap, ...override.thinkingLevelMap }
			: base.thinkingLevelMap,
	};
}

export function mergeSapModels(options: {
	packaged: SapModel[];
	cache?: SapModel[];
	overlay?: SapModelOverlay;
}): SapModel[] {
	const byId = new Map<string, SapModel>();
	for (const model of options.packaged) byId.set(model.id, model);
	for (const model of options.cache ?? []) byId.set(model.id, model);
	for (const model of options.overlay?.models ?? []) byId.set(model.id, model);

	for (const [id, override] of Object.entries(
		options.overlay?.overrides ?? {},
	)) {
		const existing = byId.get(id);
		if (existing) byId.set(id, mergeModel(existing, override));
	}

	for (const id of options.overlay?.exclude ?? []) byId.delete(id);

	return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export type LoadedSapModelCatalog = {
	models: SapModel[];
	foundationModelIds: Set<string>;
	sources: {
		packaged: SapModelsSnapshot;
		cache?: SapModelsSnapshot;
		overlay?: SapModelOverlay;
	};
};

function snapshotTimestamp(snapshot: SapModelsSnapshot | undefined): number | undefined {
	if (!snapshot?.fetchedAt) return undefined;
	const timestamp = Date.parse(snapshot.fetchedAt);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Persisted metadata may overlay the bundled snapshot only when it is not older. */
export function shouldUseCachedSnapshot(
	packaged: SapModelsSnapshot,
	cache: SapModelsSnapshot | undefined,
): boolean {
	if (!cache?.models) return false;
	const packagedAt = snapshotTimestamp(packaged);
	const cacheAt = snapshotTimestamp(cache);
	if (packagedAt === undefined || cacheAt === undefined) return true;
	return cacheAt >= packagedAt;
}

export function loadModelCatalog(): LoadedSapModelCatalog {
	const packaged = loadPackagedSnapshot();
	const cache = loadUserCache();
	const overlay = loadUserOverlay();
	const models = mergeSapModels({
		packaged: packaged.models ?? [],
		cache: shouldUseCachedSnapshot(packaged, cache) ? cache?.models : undefined,
		overlay,
	});
	const foundationModelIds = new Set([
		...DEFAULT_FOUNDATION_MODEL_IDS,
		...(overlay?.foundation?.enabledModelIds ?? []),
	]);
	return { models, foundationModelIds, sources: { packaged, cache, overlay } };
}

function thinkingMapFor(
	reasoning: boolean,
): SapModel["thinkingLevelMap"] | undefined {
	return reasoning ? { ...SAP_EFFORT_BY_LEVEL } : undefined;
}

function supportsReasoning(model: {
	id: string;
	reasoning?: boolean;
}): boolean {
	if (!model.reasoning) return false;
	if (model.id.startsWith("gemini-")) return false;
	return true;
}

export function adaptModelsDevModel(model: {
	id: string;
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	temperature?: boolean;
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
}): SapModel {
	const input = (model.modalities?.input ?? ["text"]).filter(
		(m): m is "text" | "image" | "pdf" =>
			m === "text" || m === "image" || m === "pdf",
	);
	const reasoning = supportsReasoning(model);
	const adapted: SapModel = {
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

export function shouldIncludeModelsDevModel(id: string): boolean {
	return (
		id.startsWith("anthropic--claude-4") ||
		id.startsWith("gpt-5") ||
		id.startsWith("gemini-2.5")
	);
}

export async function fetchModelsDevSapSnapshot(
	signal?: AbortSignal,
): Promise<SapModelsSnapshot> {
	const res = await fetch(MODELS_DEV_SOURCE, { signal });
	if (!res.ok) {
		throw new Error(
			`Failed to fetch ${MODELS_DEV_SOURCE}: ${res.status} ${res.statusText}`,
		);
	}
	const all = (await res.json()) as {
		"sap-ai-core"?: {
			models?: Record<string, Parameters<typeof adaptModelsDevModel>[0]>;
		};
	};
	const sapModels = all["sap-ai-core"]?.models ?? {};
	const adapted = Object.values(sapModels)
		.filter((m) => shouldIncludeModelsDevModel(m.id))
		.map(adaptModelsDevModel)
		.sort((a, b) => a.id.localeCompare(b.id));

	return {
		source: MODELS_DEV_SOURCE,
		fetchedAt: new Date().toISOString(),
		count: adapted.length,
		models: adapted,
	};
}
