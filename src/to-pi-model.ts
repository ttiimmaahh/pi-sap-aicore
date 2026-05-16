import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { SapModel } from "./models-config.ts";

export function toPiModel(model: SapModel): ProviderModelConfig {
	const input = model.modalities.input.filter(
		(m): m is "text" | "image" => m === "text" || m === "image",
	);

	return {
		id: model.id,
		name: model.name,
		api: model.backend === "anthropic" ? "anthropic-messages" : "openai-completions",
		reasoning: model.reasoning,
		input,
		cost: model.cost,
		contextWindow: model.limit.context,
		maxTokens: model.limit.output,
	};
}
