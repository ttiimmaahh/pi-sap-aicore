import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScenarioApi } from "@sap-ai-sdk/ai-api";

import { parseAndValidateServiceKey } from "./auth.ts";
import {
	fetchModelsDevSapSnapshot,
	loadModelCatalog,
	userCachePath,
	userOverlayPath,
	writeJsonFile,
} from "./model-catalog.ts";
import { ensureServiceKey, resolveResourceGroup } from "./stream.ts";

function resolveCommandServiceKey(): ReturnType<
	typeof parseAndValidateServiceKey
> {
	return ensureServiceKey(undefined);
}

function formatModelList(ids: string[], max = 30): string {
	if (ids.length === 0) return "none";
	const head = ids.slice(0, max).join(", ");
	const rest = ids.length > max ? ` … +${ids.length - max} more` : "";
	return `${head}${rest}`;
}

async function tenantModelIds(): Promise<Set<string>> {
	const key = resolveCommandServiceKey();
	parseAndValidateServiceKey(key.raw);
	process.env.AICORE_SERVICE_KEY = key.raw;
	const resourceGroup = resolveResourceGroup(key) ?? "default";
	const response = await ScenarioApi.scenarioQueryModels("foundation-models", {
		"AI-Resource-Group": resourceGroup,
	}).execute();
	const resources = response?.resources ?? [];
	return new Set(resources.map((r) => r.model));
}

export function registerSapModelCommands(
	pi: ExtensionAPI,
	onModelsChanged?: () => void,
): void {
	pi.registerCommand("sap-models", {
		description:
			"Manage pi-sap-aicore model metadata: update, discover, list, paths",
		getArgumentCompletions: (prefix) => {
			const commands = ["update", "discover", "list", "paths", "help"];
			const items = commands.map((command) => ({
				value: command,
				label: command,
			}));
			const filtered = items.filter((item) =>
				item.value.startsWith(prefix.trim()),
			);
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			const [subcommand = "help"] = args.trim().split(/\s+/, 1);
			try {
				switch (subcommand) {
					case "update": {
						ctx.ui.setStatus("sap-models", "updating model cache…");
						const snapshot = await fetchModelsDevSapSnapshot();
						writeJsonFile(userCachePath(), snapshot);
						onModelsChanged?.();
						ctx.ui.notify(
							`Updated SAP model cache: ${snapshot.count ?? snapshot.models?.length ?? 0} models. Refreshed sap-aicore providers for this session.`,
							"info",
						);
						ctx.ui.setStatus("sap-models", undefined);
						return;
					}
					case "discover": {
						ctx.ui.setStatus("sap-models", "querying SAP tenant…");
						const tenant = await tenantModelIds();
						const catalog = loadModelCatalog();
						const known = new Set(catalog.models.map((m) => m.id));
						const tenantSorted = [...tenant].sort();
						const missing = tenantSorted.filter((id) => !known.has(id));
						const phantom = catalog.models
							.map((m) => m.id)
							.filter((id) => !tenant.has(id))
							.sort();
						ctx.ui.notify(
							`SAP tenant discovery: ${tenant.size} tenant models. Missing from pi-sap-aicore catalog: ${formatModelList(missing)}. In catalog but absent from tenant: ${formatModelList(phantom)}.`,
							missing.length > 0 || phantom.length > 0 ? "warning" : "info",
						);
						ctx.ui.setStatus("sap-models", undefined);
						return;
					}
					case "list": {
						const catalog = loadModelCatalog();
						ctx.ui.notify(
							`pi-sap-aicore catalog has ${catalog.models.length} orchestration models and ${catalog.models.filter((m) => catalog.foundationModelIds.has(m.id)).length} foundation-enabled models.`,
							"info",
						);
						return;
					}
					case "paths": {
						ctx.ui.notify(
							`SAP model files:\ncache: ${userCachePath()}\noverlay: ${userOverlayPath()}`,
							"info",
						);
						return;
					}
					case "help":
					default:
						ctx.ui.notify(
							"/sap-models update — refresh public SAP model metadata\n" +
								"/sap-models discover — compare catalog against your SAP tenant\n" +
								"/sap-models list — summarize loaded catalog\n" +
								"/sap-models paths — show user cache/overlay paths",
							"info",
						);
				}
			} catch (error) {
				ctx.ui.setStatus("sap-models", undefined);
				ctx.ui.notify(
					`SAP model command failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
