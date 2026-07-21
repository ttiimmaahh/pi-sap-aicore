#!/usr/bin/env node

import { createSapModelCatalogController } from "../src/model-catalog-controller.ts";
import { shouldUseCachedSnapshot } from "../src/model-catalog.ts";

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

const sapModel = (id) => ({
	id,
	name: id,
	reasoning: false,
	tool_call: true,
	temperature: true,
	modalities: { input: ["text"], output: ["text"] },
	limit: { context: 128000, output: 16384 },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const loadedCatalog = (ids, cache) => ({
	models: ids.map(sapModel),
	foundationModelIds: new Set(ids.slice(0, 1)),
	sources: { packaged: { models: ids.map(sapModel) }, cache },
});

console.log("Snapshot ordering");
check(
	!shouldUseCachedSnapshot(
		{ fetchedAt: "2026-07-21T10:00:00.000Z", models: [sapModel("new")] },
		{ fetchedAt: "2026-07-20T10:00:00.000Z", models: [sapModel("old")] },
	),
	"older persisted cache cannot override a newer bundled snapshot",
);
check(
	shouldUseCachedSnapshot(
		{ fetchedAt: "2026-07-20T10:00:00.000Z", models: [sapModel("old")] },
		{ fetchedAt: "2026-07-21T10:00:00.000Z", models: [sapModel("new")] },
	),
	"newer cache overlays the bundled snapshot",
);

console.log("Freshness and forced refresh");
const now = Date.parse("2026-07-21T12:00:00.000Z");
let disk = loadedCatalog(["cached"], {
	fetchedAt: "2026-07-21T11:00:00.000Z",
	models: [sapModel("cached")],
});
let fetchCount = 0;
const controller = createSapModelCatalogController({
	loadCatalog: () => disk,
	now: () => now,
	fetchSnapshot: async () => {
		fetchCount++;
		return {
			fetchedAt: "2026-07-21T12:00:00.000Z",
			models: [sapModel("refreshed")],
			count: 1,
		};
	},
	writeSnapshot: (snapshot) => {
		disk = loadedCatalog(
			(snapshot.models ?? []).map((entry) => entry.id),
			snapshot,
		);
	},
});
await controller.refresh({ allowNetwork: true });
check(fetchCount === 0, "fresh cache suppresses automatic network refresh");
await controller.refresh({ allowNetwork: true, force: true });
check(fetchCount === 1, "forced refresh bypasses freshness gate");
check(controller.getCatalog().models[0]?.id === "refreshed", "successful refresh publishes new models");

console.log("Offline reload and cancellation");
disk = loadedCatalog(["overlay-edit"], disk.sources.cache);
await controller.refresh({ allowNetwork: false });
check(controller.getCatalog().models[0]?.id === "overlay-edit", "offline refresh reloads local policy");
const aborted = new AbortController();
aborted.abort();
await controller.refresh({ allowNetwork: true, force: true, signal: aborted.signal });
check(fetchCount === 1, "already-aborted refresh performs no network request");

console.log("Failure retention");
const stable = loadedCatalog(["stable"], undefined);
let failingDisk = stable;
const failing = createSapModelCatalogController({
	loadCatalog: () => failingDisk,
	fetchSnapshot: async () => {
		throw new Error("network down");
	},
	writeSnapshot: () => {
		throw new Error("must not write");
	},
});
failingDisk = loadedCatalog(["unpublished-local-reload"], undefined);
try {
	await failing.refresh({ allowNetwork: true, force: true });
	check(false, "failed refresh rejects");
} catch {
	check(true, "failed refresh rejects");
}
check(failing.getCatalog().models[0]?.id === "stable", "failed online refresh retains published models");

console.log("Incompatible cancellation signals");
let cancellationFetchCount = 0;
const cancelFirst = new AbortController();
const cancellationSafe = createSapModelCatalogController({
	loadCatalog: () => stable,
	fetchSnapshot: (signal) => {
		cancellationFetchCount++;
		if (!signal) {
			return Promise.resolve({
				fetchedAt: new Date(now).toISOString(),
				models: [sapModel("retry-after-cancel")],
			});
		}
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
				once: true,
			});
		});
	},
	writeSnapshot: () => {},
});
const cancelledRequest = cancellationSafe.refresh({
	allowNetwork: true,
	force: true,
	signal: cancelFirst.signal,
});
const independentRequest = cancellationSafe.refresh({ allowNetwork: true, force: true });
cancelFirst.abort();
try {
	await cancelledRequest;
} catch {}
await independentRequest;
check(cancellationFetchCount === 2, "differently signaled callers get independent refresh attempts");

console.log("Concurrent deduplication");
let releaseFetch;
let concurrentFetchCount = 0;
const deferred = new Promise((resolve) => {
	releaseFetch = resolve;
});
const concurrent = createSapModelCatalogController({
	loadCatalog: () => stable,
	fetchSnapshot: async () => {
		concurrentFetchCount++;
		await deferred;
		return { fetchedAt: new Date(now).toISOString(), models: [sapModel("deduped")] };
	},
	writeSnapshot: () => {},
});
const first = concurrent.refresh({ allowNetwork: true, force: true });
const second = concurrent.refresh({ allowNetwork: true, force: true });
releaseFetch();
await Promise.all([first, second]);
check(concurrentFetchCount === 1, "simultaneous provider refreshes share one request");

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll model refresh checks passed");
