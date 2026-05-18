import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODELS } from "./src/models-config.ts";
import { toPiModel } from "./src/to-pi-model.ts";

const PROVIDER_NAME = "sap-aicore";
const PROVIDER_API = "sap-aicore-orchestration" as Api;

// `streamSapAiCore` lives behind a dynamic import because it transitively
// imports `@sap-ai-sdk/orchestration`. If that dependency is missing (pi's
// `npm install` step didn't run, or got interrupted), a static import would
// throw at module-load time with a raw Node `ERR_MODULE_NOT_FOUND` and the
// provider would just look broken. Loading it lazily lets us catch that
// specific failure and translate it into actionable user instructions.
async function loadStreamFn() {
	try {
		const mod = await import("./src/stream.ts");
		return mod.streamSapAiCore;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		const msg = (err as Error)?.message ?? "";
		const isMissingSapSdk =
			code === "ERR_MODULE_NOT_FOUND" &&
			msg.includes("@sap-ai-sdk/orchestration");
		if (!isMissingSapSdk) throw err;

		// TODO(user): write the missing-dependency error message.
		// This fires when pi installed the provider but the SAP AI Core SDK
		// (@sap-ai-sdk/orchestration) isn't on disk — usually because
		// `npm install` didn't run during `pi install`. Tell the user:
		//   - what's wrong (in one sentence)
		//   - exactly what to do to fix it (the command(s) to run)
		//   - where to look if they want more context (README link?)
		// Keep it scannable — this lands in a TUI error toast/panel.
		throw new Error("TODO: missing-dependency message");
	}
}

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
		// Defer SAP-SDK load to first use so missing-dep errors surface
		// with the friendly message above instead of a raw module-load
		// crash during pi startup.
		streamSimple: async (...args) => {
			const fn = await loadStreamFn();
			return fn(...args);
		},
	});
}
