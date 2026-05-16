import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODELS } from "./src/models-config.ts";
import { streamSapAiCore } from "./src/stream.ts";
import { toPiModel } from "./src/to-pi-model.ts";

const PROVIDER_NAME = "sap-aicore";
const PROVIDER_API = "sap-aicore-orchestration" as Api;

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_NAME, {
		name: "SAP AI Core",
		baseUrl: "https://sap-aicore-handled-by-sdk.invalid",
		apiKey: "AICORE_SERVICE_KEY",
		api: PROVIDER_API,
		// Resource-group selection lives in stream.ts (passed to
		// OrchestrationClient's deploymentConfig); SAP's typings reject
		// it as a header (`'AI-Resource-Group'?: never`). A `headers`
		// entry here would also be a no-op anyway — pi only forwards
		// `headers` when it makes the HTTP request itself, but we use
		// `streamSimple` and the SAP SDK handles transport.
		models: MODELS.map((m) => toPiModel(m, PROVIDER_API)),
		streamSimple: streamSapAiCore,
	});
}
