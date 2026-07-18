import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { sapAiCoreOAuth } from "./src/auth.ts";
import { loadModelCatalog } from "./src/model-catalog.ts";
import { registerSapModelCommands } from "./src/sap-model-commands.ts";
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

// The foundation provider has no OAuth entry of its own: it shares the
// orchestration provider's stored login in stream.ts. Pi still requires every
// provider to expose an authentication method, so this keeps foundation models
// selectable without adding a duplicate SAP AI Core entry to `/login`.
const FOUNDATION_PLACEHOLDER_API_KEY = "managed-by-extension-oauth";

export default function (pi: ExtensionAPI) {
	const registerProviders = () => {
		const catalog = loadModelCatalog();
		const models = catalog.models;
		const foundationModels = models.filter((m) =>
			catalog.foundationModelIds.has(m.id),
		);

		pi.registerProvider(PROVIDER_NAME, {
			name: "SAP AI Core",
			baseUrl: "https://sap-aicore-handled-by-sdk.invalid",
			// Unlike a literal placeholder, this only makes Pi report the provider as
			// configured when the environment variable is actually present. Stored
			// subscription credentials continue to flow through `oauth` below.
			apiKey: "$AICORE_SERVICE_KEY",
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
			models: models.map((m) => toPiModel(m, PROVIDER_API)),
			// Synchronous, as pi's provider contract requires. The SAP SDK is still
			// deferred to first use — `stream.ts` only `import type`s it at module
			// load and dynamically imports the OrchestrationClient inside the stream
			// producer, surfacing a missing-dependency error through the stream.
			streamSimple: streamSapAiCore,
		});

		// Foundation provider — shares the exact same credential via
		// `ensureServiceKey`'s auth-store fallback instead of registering its own
		// OAuth provider. Registering `oauth: sapAiCoreOAuth` here would make `/login`
		// show a second, confusing "SAP AI Core" subscription entry because pi keys
		// OAuth providers by provider id (`sap-aicore-foundation`), not by OAuth name.
		// Models appear under `sap-aicore-foundation/…`; streaming runs natively here
		// (no orchestration streaming-unsupported fallback). The foundation SDK is
		// dynamically imported inside `streamSapFoundation`, same deferral as above.
		pi.registerProvider(FOUNDATION_PROVIDER_NAME, {
			name: "SAP AI Core (Foundation)",
			baseUrl: "https://sap-aicore-handled-by-sdk.invalid",
			apiKey: FOUNDATION_PLACEHOLDER_API_KEY,
			api: FOUNDATION_PROVIDER_API,
			models: foundationModels.map((m) =>
				toPiModel(m, FOUNDATION_PROVIDER_API),
			),
			streamSimple: streamSapFoundation,
		});
	};

	registerSapModelCommands(pi, registerProviders);
	registerProviders();
}
