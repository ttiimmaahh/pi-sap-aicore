import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// The subset of the Azure OpenAI chat-completion request body we set per turn.
// Field choices are dictated by what `@sap-ai-sdk/foundation-models`' request
// schema actually exposes (it pins Azure API version 2024-10-21):
//   - `max_tokens` AND `max_completion_tokens` both exist; reasoning models
//     (gpt-5*, o-series) reject `max_tokens` and require `max_completion_tokens`.
//   - `reasoning_effort` is NOT in this schema/version, so depth is the model's
//     own default and pi's reasoning-level selector is a no-op on this route
//     (see note below). Orchestration remains the path for tuned effort.
//   - `temperature` exists but gpt-5* reject it ("Unsupported parameter").
export type AzureOpenAiParams = {
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
};

// Build the per-turn Azure OpenAI params for a foundation (direct) request.
//
// This is the foundation analogue of `buildLlmParams` in stream.ts, but far
// smaller: the direct Azure-OpenAI endpoint is OpenAI-only, so all of the
// Anthropic adaptive/budget-thinking branching collapses away.
//
// REASONING NOTE: gpt-5.5 still reasons here — it just reasons at its built-in
// default effort, because `reasoning_effort` isn't expressible against API
// version 2024-10-21. If a future SDK bump exposes it (or SAP accepts it as a
// passthrough field), add it here off `model.thinkingLevelMap[reasoning]`.
//
// VERIFY ON FIRST LIVE CALL: that gpt-5.5 accepts `max_completion_tokens` (and
// rejects `max_tokens`) on your tenant. If SAP's proxy unexpectedly wants
// `max_tokens` for this model, flip the branch below — the error will say so.
export function buildAzureOpenAiParams(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): AzureOpenAiParams {
	// Pi may pass a tighter budget than the model's hard cap (to reserve room
	// for thinking). Respect it; otherwise use the model's documented max output.
	const effectiveMaxTokens = options?.maxTokens ?? model.maxTokens;

	const params: AzureOpenAiParams = {};
	if (model.reasoning) {
		params.max_completion_tokens = effectiveMaxTokens;
	} else {
		params.max_tokens = effectiveMaxTokens;
	}

	// Only forward temperature for models that accept it. gpt-5* reject it; the
	// snapshot records `temperature:false`, but we gate on the id prefix here to
	// stay self-contained (mirrors `modelSupportsTemperature` in stream.ts).
	if (options?.temperature !== undefined && !model.id.startsWith("gpt-5")) {
		params.temperature = options.temperature;
	}

	return params;
}
