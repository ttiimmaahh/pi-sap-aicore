import {
	fetchModelsDevSapSnapshot,
	loadModelCatalog,
	type LoadedSapModelCatalog,
	type SapModelsSnapshot,
	userCachePath,
	writeJsonFile,
} from "./model-catalog.ts";

const DEFAULT_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface SapCatalogRefreshOptions {
	allowNetwork: boolean;
	force?: boolean;
	signal?: AbortSignal;
}

export interface SapModelCatalogControllerOptions {
	loadCatalog?: () => LoadedSapModelCatalog;
	fetchSnapshot?: (signal?: AbortSignal) => Promise<SapModelsSnapshot>;
	writeSnapshot?: (snapshot: SapModelsSnapshot) => void;
	now?: () => number;
	refreshIntervalMs?: number;
}

export interface SapModelCatalogController {
	getCatalog(): LoadedSapModelCatalog;
	refresh(options: SapCatalogRefreshOptions): Promise<SapModelsSnapshot | undefined>;
}

function fetchedAt(snapshot: SapModelsSnapshot | undefined): number | undefined {
	if (!snapshot?.fetchedAt) return undefined;
	const timestamp = Date.parse(snapshot.fetchedAt);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function createSapModelCatalogController(
	options: SapModelCatalogControllerOptions = {},
): SapModelCatalogController {
	const loadCatalog = options.loadCatalog ?? loadModelCatalog;
	const fetchSnapshot = options.fetchSnapshot ?? fetchModelsDevSapSnapshot;
	const writeSnapshot = options.writeSnapshot ?? ((snapshot) => writeJsonFile(userCachePath(), snapshot));
	const now = options.now ?? Date.now;
	const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

	let catalog = loadCatalog();
	let inFlight: Promise<SapModelsSnapshot | undefined> | undefined;
	let inFlightSignal: AbortSignal | undefined;

	const refresh = async (
		refreshOptions: SapCatalogRefreshOptions,
	): Promise<SapModelsSnapshot | undefined> => {
		if (inFlight) {
			const activeRefresh = inFlight;
			if (inFlightSignal === refreshOptions.signal) return activeRefresh;
			try {
				await activeRefresh;
			} catch {
				// A differently signaled caller gets its own attempt below.
			}
			return refresh(refreshOptions);
		}

		const localCandidate = loadCatalog();
		const currentCache = localCandidate.sources.cache;
		if (!refreshOptions.allowNetwork || refreshOptions.signal?.aborted) {
			catalog = localCandidate;
			return currentCache;
		}

		const checkedAt = fetchedAt(currentCache);
		if (
			!refreshOptions.force &&
			checkedAt !== undefined &&
			now() - checkedAt < refreshIntervalMs
		) {
			catalog = localCandidate;
			return currentCache;
		}

		inFlightSignal = refreshOptions.signal;
		inFlight = (async () => {
			try {
				const snapshot = await fetchSnapshot(refreshOptions.signal);
				if (refreshOptions.signal?.aborted) return undefined;
				writeSnapshot(snapshot);
				if (refreshOptions.signal?.aborted) return undefined;
				const refreshedCatalog = loadCatalog();
				catalog = refreshedCatalog;
				return snapshot;
			} finally {
				inFlight = undefined;
				inFlightSignal = undefined;
			}
		})();
		return inFlight;
	};

	return {
		getCatalog: () => catalog,
		refresh,
	};
}
