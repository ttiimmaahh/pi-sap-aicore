import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
	createSapApiKeyAuth,
	legacySapServiceKeyOAuth,
	readSharedServiceKeyFromStore,
	SAP_PROVIDER_ID,
} from "./auth.ts";
import type { SapModelCatalogController } from "./model-catalog-controller.ts";
import { streamSapFoundation } from "./stream-foundation.ts";
import { streamSapAiCore } from "./stream.ts";
import { toPiModel } from "./to-pi-model.ts";

export { SAP_PROVIDER_ID } from "./auth.ts";

export const FOUNDATION_PROVIDER_ID = "sap-aicore-foundation";
export const SAP_ORCHESTRATION_API = "sap-aicore-orchestration" as Api;
export const SAP_FOUNDATION_API = "sap-aicore-foundation" as Api;

// SAP SDK clients own the actual request endpoints. Models still require a
// baseUrl as serializable metadata, so use a deliberately non-routable value.
const SDK_MANAGED_BASE_URL = "https://sap-aicore-handled-by-sdk.invalid";

type SapStream = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

function createStreamMethods(streamSimple: SapStream): Pick<Provider<Api>, "stream" | "streamSimple"> {
	return {
		stream<T extends Api>(
			model: Model<T>,
			context: Context,
			options?: ApiStreamOptions<T>,
		): AssistantMessageEventStream {
			// SAP's custom APIs expose one unified option surface. Pi's coding agent
			// calls streamSimple; direct full-stream callers receive the common fields.
			return streamSimple(model, context, options as SimpleStreamOptions | undefined);
		},
		streamSimple,
	};
}

export interface CreateSapProvidersOptions {
	readSharedServiceKey?: () => string | undefined;
}

export interface SapProviders {
	orchestration: Provider<Api>;
	foundation: Provider<Api>;
}

export function createSapProviders(
	controller: SapModelCatalogController,
	options: CreateSapProvidersOptions = {},
): SapProviders {
	const refreshModels: NonNullable<Provider<Api>["refreshModels"]> = async (context) => {
		await controller.refresh({
			allowNetwork: context.allowNetwork,
			force: context.force,
			signal: context.signal,
		});
	};

	const orchestrationStreams = createStreamMethods(streamSapAiCore);
	const foundationStreams = createStreamMethods(streamSapFoundation);

	const orchestration: Provider<Api> = {
		id: SAP_PROVIDER_ID,
		name: "SAP AI Core",
		baseUrl: SDK_MANAGED_BASE_URL,
		auth: {
			apiKey: createSapApiKeyAuth({ login: true }),
			oauth: legacySapServiceKeyOAuth,
		},
		getModels: () =>
			controller
				.getCatalog()
				.models.map((model) =>
					toPiModel(model, SAP_PROVIDER_ID, SAP_ORCHESTRATION_API, SDK_MANAGED_BASE_URL),
				),
		refreshModels,
		...orchestrationStreams,
	};

	const foundation: Provider<Api> = {
		id: FOUNDATION_PROVIDER_ID,
		name: "SAP AI Core (Foundation)",
		baseUrl: SDK_MANAGED_BASE_URL,
		auth: {
			apiKey: createSapApiKeyAuth({
				login: false,
				readSharedServiceKey: options.readSharedServiceKey ?? readSharedServiceKeyFromStore,
			}),
		},
		getModels: () => {
			const catalog = controller.getCatalog();
			return catalog.models
				.filter((model) => catalog.foundationModelIds.has(model.id))
				.map((model) =>
					toPiModel(model, FOUNDATION_PROVIDER_ID, SAP_FOUNDATION_API, SDK_MANAGED_BASE_URL),
				);
		},
		refreshModels,
		...foundationStreams,
	};

	return { orchestration, foundation };
}
