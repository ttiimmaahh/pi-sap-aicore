import {
	DEFAULT_FOUNDATION_MODEL_IDS,
	loadModelCatalog,
	type SapModel,
} from "./model-catalog.ts";

export type { SapModel } from "./model-catalog.ts";

const catalog = loadModelCatalog();

export const MODELS: SapModel[] = catalog.models;

// Models exposed via the direct *foundation* (Azure OpenAI) provider, which
// routes through a per-model SAP AI Core deployment instead of orchestration.
// List ONLY ids you've created a foundation-models deployment for — SAP needs
// one deployment per (model, version, resource group), and an id with no
// deployment 404s at call time. Definitions (cost/limits/modalities) are reused
// from the shared catalog above, so an id only has to be present there.
//
// Per-machine additions should go in:
//   ~/.pi/agent/pi-sap-aicore/models.json
//
// Example:
//   { "foundation": { "enabledModelIds": ["gpt-5.5"] } }
export const FOUNDATION_MODEL_IDS = catalog.foundationModelIds;
export const DEFAULT_FOUNDATION_IDS = DEFAULT_FOUNDATION_MODEL_IDS;

export const FOUNDATION_MODELS: SapModel[] = MODELS.filter((m) =>
	FOUNDATION_MODEL_IDS.has(m.id),
);
