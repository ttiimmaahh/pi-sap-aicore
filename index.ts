import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { sapAiCoreOAuth } from "./src/auth.ts";
import { FOUNDATION_MODELS, MODELS } from "./src/models-config.ts";
import { streamSapAiCore } from "./src/stream.ts";
import { streamSapFoundation } from "./src/stream-foundation.ts";
import { toPiModel } from "./src/to-pi-model.ts";

const PROVIDER_NAME = "sap-aicore";
const PROVIDER_API = "sap-aicore-orchestration" as Api;

// Second provider: direct foundation (Azure OpenAI) deployments, registered
// alongside orchestration so both routes are independently selectable
// (e.g. `sap-aicore/gpt-5.5` vs `sap-aicore-foundation/gpt-5.5`).
const FOUNDATION_PROVIDER_NAME = "sap-aicore-foundation";
const FOUNDATION_PROVIDER_API = "sap-aicore-foundation" as Api;

// pi requires a non-empty `apiKey` for any custom provider that defines models
// (model-registry `validateConfig`), even when credentials come from `oauth`.
// This value is never used: the real key is supplied by `sapAiCoreOAuth`
// (after `/login`) or by AICORE_SERVICE_KEY (both handled in stream.ts). It is a
// plain lowercase literal so pi's config-value resolver returns it as-is — no
// `$` interpolation, no shell exec, and not mistaken for a legacy env-var name.
const PLACEHOLDER_API_KEY = "managed-by-extension-oauth";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_NAME, {
		name: "SAP AI Core",
		baseUrl: "https://sap-aicore-handled-by-sdk.invalid",
		apiKey: PLACEHOLDER_API_KEY,
		api: PROVIDER_API,
		// Credentials flow through pi's `oauth` path — its escape hatch from the
		// $-interpolating config-value resolver that corrupts service keys
		// containing `$` (SAP keys have one in `clientsecret`). `/login → Use a
		// subscription → SAP AI Core` captures the service-key JSON; `getApiKey`
		// returns it verbatim as `options.apiKey` to `streamSimple`.
		oauth: sapAiCoreOAuth,
		// Resource-group selection lives in stream.ts (passed to
		// OrchestrationClient's deploymentConfig); SAP's typings reject
		// it as a header (`'AI-Resource-Group'?: never`). A `headers`
		// entry here would also be a no-op anyway — pi only forwards
		// `headers` when it makes the HTTP request itself, but we use
		// `streamSimple` and the SAP SDK handles transport.
		models: MODELS.map((m) => toPiModel(m, PROVIDER_API)),
		// Synchronous, as pi's provider contract requires. The SAP SDK is still
		// deferred to first use — `stream.ts` only `import type`s it at module
		// load and dynamically imports the OrchestrationClient inside the stream
		// producer, surfacing a missing-dependency error through the stream.
		streamSimple: streamSapAiCore,
	});

	// Foundation provider — shares the exact same credential. Both providers
	// reference the same `sapAiCoreOAuth` (oauth name "SAP AI Core"), so a single
	// `/login` serves both and the service key is never entered twice. Models
	// appear under `sap-aicore-foundation/…`; streaming runs natively here (no
	// orchestration streaming-unsupported fallback). The foundation SDK is
	// dynamically imported inside `streamSapFoundation`, same deferral as above.
	pi.registerProvider(FOUNDATION_PROVIDER_NAME, {
		name: "SAP AI Core (Foundation)",
		baseUrl: "https://sap-aicore-handled-by-sdk.invalid",
		apiKey: PLACEHOLDER_API_KEY,
		api: FOUNDATION_PROVIDER_API,
		oauth: sapAiCoreOAuth,
		models: FOUNDATION_MODELS.map((m) => toPiModel(m, FOUNDATION_PROVIDER_API)),
		streamSimple: streamSapFoundation,
	});
}
