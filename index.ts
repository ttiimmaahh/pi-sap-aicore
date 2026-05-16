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
		headers: {
			"AI-Resource-Group": "default",
		},
		models: MODELS.map((m) => toPiModel(m, PROVIDER_API)),
		streamSimple: streamSapAiCore,
	});
}
