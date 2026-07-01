import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { foundationExecutableForModel } from "./foundation-executables.ts";
import { streamSapFoundationAzureOpenAi } from "./stream-foundation-azure-openai.ts";
import { streamSapFoundationBedrock } from "./stream-foundation-bedrock.ts";

export function streamSapFoundation(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const executable = foundationExecutableForModel(model.id);
	switch (executable) {
		case "azure-openai":
			return streamSapFoundationAzureOpenAi(model, context, options);
		case "aws-bedrock":
			return streamSapFoundationBedrock(model, context, options);
		case "gcp-vertexai":
			throw new Error(
				`SAP AI Core foundation executable '${executable}' is mapped for '${model.id}', ` +
					"but the Vertex AI/Gemini foundation adapter has not been implemented yet. " +
					"Use sap-aicore orchestration for this model until the gcp-vertexai adapter is added.",
			);
	}
}
