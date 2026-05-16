import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type ChatModel,
	type LlmModelParams,
	OrchestrationClient,
} from "@sap-ai-sdk/orchestration";

import { mapFinishReason, piContextToOrchestration } from "./translate.ts";

// SAP SDK wraps server-side errors as `Error while iterating over SSE stream`
// with the real error attached via `.cause`. Walk the chain so the user sees
// what SAP/Anthropic actually complained about.
function formatError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	while (current instanceof Error) {
		parts.push(current.message);
		current = (current as Error & { cause?: unknown }).cause;
	}
	if (current !== undefined && current !== null) parts.push(String(current));
	return parts.length > 0 ? parts.join(" → ") : String(error);
}

function reasoningParams(
	model: Model<Api>,
	reasoning: string | undefined,
): Partial<LlmModelParams> {
	if (!reasoning || reasoning === "off") return {};
	const effort = model.thinkingLevelMap?.[reasoning as keyof NonNullable<typeof model.thinkingLevelMap>];
	if (!effort) return {};

	// SAP orchestration normalizes reasoning across providers (Claude,
	// GPT, Gemini all share this shape; raw provider params like
	// Anthropic's `thinking.type.enabled` + `budget_tokens` are rejected
	// with HTTP 400). `thinking.type: "adaptive"` enables provider-managed
	// thinking; `output_config.effort` is a tiered string.
	return {
		thinking: { type: "adaptive" },
		output_config: { effort },
	};
}

type ToolCallSlot = {
	contentIndex: number;
	partialJson: string;
};

const REQUIRED_FIELDS = [
	"clientid",
	"clientsecret",
	"url",
	"serviceurls.AI_API_URL",
] as const;

let lastValidatedKey: string | undefined;

function ensureServiceKey(apiKey: string | undefined): string {
	const raw = apiKey ?? process.env.AICORE_SERVICE_KEY;
	if (!raw) {
		throw new Error(
			"No SAP AI Core service key configured. Run `/login` in pi, " +
				"pick 'Use an API key' → 'SAP AI Core', and paste your BTP " +
				"service-key JSON. Or set AICORE_SERVICE_KEY in your shell.",
		);
	}

	if (raw === lastValidatedKey) return raw;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			"SAP AI Core key must be the full BTP service-key JSON, not a " +
				"plain string. Get it from BTP cockpit → AI Core service " +
				`instance → Service Keys → View. Got: ${raw.slice(0, 40)}...`,
		);
	}

	const missing = REQUIRED_FIELDS.filter((path) => {
		const value = path.split(".").reduce<unknown>(
			(acc, segment) =>
				acc && typeof acc === "object" && segment in (acc as object)
					? (acc as Record<string, unknown>)[segment]
					: undefined,
			parsed,
		);
		return typeof value !== "string" || value.length === 0;
	});

	if (missing.length > 0) {
		throw new Error(
			`SAP AI Core service-key JSON is missing required fields: ${missing.join(", ")}. ` +
				"Make sure you pasted the entire service-key object from BTP cockpit.",
		);
	}

	lastValidatedKey = raw;
	return raw;
}

export function streamSapAiCore(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			stream.push({ type: "start", partial: output });

			const serviceKey = ensureServiceKey(options?.apiKey);
			process.env.AICORE_SERVICE_KEY = serviceKey;

			const { messages, tools } = piContextToOrchestration(context);

			const client = new OrchestrationClient({
				promptTemplating: {
					model: {
						name: model.id as ChatModel,
						params: {
							max_tokens: model.maxTokens,
							...reasoningParams(model, options?.reasoning),
						},
					},
					prompt: {
						template: [],
						...(tools.length > 0 ? { tools } : {}),
					},
				},
			});

			const response = await client.stream(
				{ messages },
				options?.signal,
				{ promptTemplating: { include_usage: true } },
			);

			let textIndex = -1;
			const toolSlots = new Map<number, ToolCallSlot>();
			let finishReason: string | undefined;

			for await (const chunk of response.stream) {
				if (options?.signal?.aborted) break;

				const delta = chunk.getDeltaContent();
				if (delta) {
					if (textIndex < 0) {
						output.content.push({ type: "text", text: "" });
						textIndex = output.content.length - 1;
						stream.push({
							type: "text_start",
							contentIndex: textIndex,
							partial: output,
						});
					}
					const block = output.content[textIndex];
					if (block?.type === "text") {
						block.text += delta;
						stream.push({
							type: "text_delta",
							contentIndex: textIndex,
							delta,
							partial: output,
						});
					}
				}

				const toolDeltas = chunk.getDeltaToolCalls();
				if (toolDeltas && toolDeltas.length > 0) {
					if (textIndex >= 0) {
						const block = output.content[textIndex];
						if (block?.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: textIndex,
								content: block.text,
								partial: output,
							});
						}
						textIndex = -1;
					}

					for (const td of toolDeltas) {
						let slot = toolSlots.get(td.index);
						if (!slot) {
							output.content.push({
								type: "toolCall",
								id: td.id ?? "",
								name: td.function?.name ?? "",
								arguments: {},
							});
							slot = {
								contentIndex: output.content.length - 1,
								partialJson: "",
							};
							toolSlots.set(td.index, slot);
							stream.push({
								type: "toolcall_start",
								contentIndex: slot.contentIndex,
								partial: output,
							});
						}

						const block = output.content[slot.contentIndex];
						if (block?.type === "toolCall") {
							if (td.id && !block.id) block.id = td.id;
							if (td.function?.name && !block.name) block.name = td.function.name;

							const fragment = td.function?.arguments ?? "";
							if (fragment) {
								slot.partialJson += fragment;
								try {
									block.arguments = JSON.parse(slot.partialJson);
								} catch {
									// Partial JSON — keep accumulating until valid
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: slot.contentIndex,
									delta: fragment,
									partial: output,
								});
							}
						}
					}
				}

				const chunkFinish = chunk.getFinishReason();
				if (chunkFinish) finishReason = chunkFinish;
			}

			if (textIndex >= 0) {
				const block = output.content[textIndex];
				if (block?.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: textIndex,
						content: block.text,
						partial: output,
					});
				}
			}

			for (const slot of toolSlots.values()) {
				const block = output.content[slot.contentIndex];
				if (block?.type === "toolCall") {
					if (slot.partialJson) {
						try {
							block.arguments = JSON.parse(slot.partialJson);
						} catch {
							// Leave arguments as last successfully-parsed value
						}
					}
					stream.push({
						type: "toolcall_end",
						contentIndex: slot.contentIndex,
						toolCall: {
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.arguments,
						},
						partial: output,
					});
				}
			}

			const usage = response.getTokenUsage();
			if (usage) {
				output.usage.input = usage.prompt_tokens ?? 0;
				output.usage.output = usage.completion_tokens ?? 0;
				output.usage.totalTokens =
					usage.total_tokens ?? output.usage.input + output.usage.output;
				calculateCost(model, output.usage);
			}

			output.stopReason = mapFinishReason(
				finishReason ?? response.getFinishReason(),
			);

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			stream.push({
				type: "error",
				reason: output.stopReason as "error" | "aborted",
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}
