import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScenarioApi } from "@sap-ai-sdk/ai-api";

import { SAP_PROVIDER_ID } from "./auth.ts";
import type { SapModelCatalogController } from "./model-catalog-controller.ts";
import { userCachePath, userOverlayPath } from "./model-catalog.ts";
import { ensureServiceKey, resolveResourceGroup } from "./stream.ts";

function formatModelList(ids: string[], max = 30): string {
	if (ids.length === 0) return "none";
	const head = ids.slice(0, max).join(", ");
	const rest = ids.length > max ? ` … +${ids.length - max} more` : "";
	return `${head}${rest}`;
}

async function tenantModelIds(serviceKey: string): Promise<Set<string>> {
	const key = ensureServiceKey(serviceKey);
	process.env.AICORE_SERVICE_KEY = key.raw;
	const resourceGroup = resolveResourceGroup(key) ?? "default";
	const response = await ScenarioApi.scenarioQueryModels("foundation-models", {
		"AI-Resource-Group": resourceGroup,
	}).execute();
	const resources = response?.resources ?? [];
	return new Set(resources.map((resource) => resource.model));
}

export function registerSapModelCommands(
	pi: ExtensionAPI,
	controller: SapModelCatalogController,
): void {
	pi.registerCommand("sap-models", {
		description:
			"Manage pi-sap-aicore model metadata: update, discover, list, paths",
		getArgumentCompletions: (prefix) => {
			const commands = ["update", "discover", "list", "paths", "help"];
			const items = commands.map((command) => ({ value: command, label: command }));
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			const [subcommand = "help"] = args.trim().split(/\s+/, 1);
			try {
				switch (subcommand) {
					case "update": {
						ctx.ui.setStatus("sap-models", "updating model cache…");
						const snapshot = await controller.refresh({ allowNetwork: true, force: true });
						ctx.ui.notify(
							`Updated SAP model cache: ${snapshot?.count ?? snapshot?.models?.length ?? controller.getCatalog().models.length} models. Refreshed sap-aicore providers for this session.`,
							"info",
						);
						return;
					}
					case "discover": {
						ctx.ui.setStatus("sap-models", "querying SAP tenant…");
						const auth = await ctx.modelRegistry.getProviderAuth(SAP_PROVIDER_ID);
						const key = ensureServiceKey(auth?.auth.apiKey);
						const tenant = await tenantModelIds(key.raw);
						await controller.refresh({ allowNetwork: false });
						const catalog = controller.getCatalog();
						const known = new Set(catalog.models.map((model) => model.id));
						const tenantSorted = [...tenant].sort((a, b) => a.localeCompare(b));
						const missing = tenantSorted.filter((id) => !known.has(id));
						const phantom = catalog.models
							.map((model) => model.id)
							.filter((id) => !tenant.has(id))
							.sort((a, b) => a.localeCompare(b));
						ctx.ui.notify(
							`SAP tenant discovery: ${tenant.size} tenant models. Missing from pi-sap-aicore catalog: ${formatModelList(missing)}. In catalog but absent from tenant: ${formatModelList(phantom)}.`,
							missing.length > 0 || phantom.length > 0 ? "warning" : "info",
						);
						return;
					}
					case "list": {
						await controller.refresh({ allowNetwork: false });
						const catalog = controller.getCatalog();
						ctx.ui.notify(
							`pi-sap-aicore catalog has ${catalog.models.length} orchestration models and ${catalog.models.filter((model) => catalog.foundationModelIds.has(model.id)).length} foundation-enabled models.`,
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
				ctx.ui.notify(
					`SAP model command failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("sap-models", undefined);
			}
		},
	});
}
