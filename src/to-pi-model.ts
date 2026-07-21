import type { Api, Model } from "@earendil-works/pi-ai";
import type { SapModel } from "./model-catalog.ts";

export function toPiModel(
	model: SapModel,
	provider: string,
	api: Api,
	baseUrl: string,
): Model<Api> {
	const input = model.modalities.input.filter(
		(modality): modality is "text" | "image" =>
			modality === "text" || modality === "image",
	);

	return {
		id: model.id,
		name: model.name,
		api,
		provider,
		baseUrl,
		reasoning: model.reasoning,
		input,
		cost: model.cost,
		contextWindow: model.limit.context,
		maxTokens: model.limit.output,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}
