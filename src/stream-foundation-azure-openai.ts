import { randomUUID } from "node:crypto";

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
import type { AzureOpenAiChatCompletionParameters } from "@sap-ai-sdk/foundation-models";

import { buildAzureOpenAiParams } from "./foundation-params.ts";
import {
	debugLog,
	ensureServiceKey,
	type ExtendedDelta,
	formatError,
	latchFinishReason,
	mapUsage,
	pickReasoning,
	resolveResourceGroup,
	type ToolCallSlot,
} from "./stream.ts";
import { mapFinishReason } from "./translate.ts";
import { piContextToAzureOpenAi } from "./translate-foundation.ts";

// Loaded dynamically (not at module load) so a missing dependency surfaces as
// an actionable in-stream error instead of an ERR_MODULE_NOT_FOUND crash at pi
// startup. Mirrors `importOrchestration` in stream.ts.
async function importFoundation(): Promise<
	typeof import("@sap-ai-sdk/foundation-models")
> {
	try {
		return await import("@sap-ai-sdk/foundation-models");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		const msg = (err as Error)?.message ?? "";
		const isMissing =
			code === "ERR_MODULE_NOT_FOUND" &&
			msg.includes("@sap-ai-sdk/foundation-models");
		if (!isMissing) throw err;

		throw new Error(
			"The SAP AI Core foundation-models SDK (@sap-ai-sdk/foundation-models) " +
				"isn't installed, so the foundation provider can't make requests. Fix: " +
				"run `npm install` in the pi-sap-aicore directory (where pi installed " +
				"it, e.g. under ~/.pi/agent/), then restart pi.",
		);
	}
}

// Direct (foundation) provider: routes OpenAI models through their own
// SAP AI Core deployment via @sap-ai-sdk/foundation-models'
// AzureOpenAiChatClient — bypassing the orchestration service entirely.
// Unlike streamSapAiCore there is NO streaming-unsupported fallback: the
// direct Azure OpenAI endpoint streams natively (that's the whole reason this
// path exists for new models orchestration won't stream). The SDK injects
// `stream_options: { include_usage: true }` itself, so usage arrives on the
// final chunk and `response.getTokenUsage()` is populated.
export function streamSapFoundationAzureOpenAi(
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
		const requestId = randomUUID();
		try {
			stream.push({ type: "start", partial: output });

			const serviceKey = ensureServiceKey(options?.apiKey);
			process.env.AICORE_SERVICE_KEY = serviceKey.raw;
			const resourceGroup = resolveResourceGroup(serviceKey);

			const { messages, tools } = piContextToAzureOpenAi(context);
			const params = buildAzureOpenAiParams(model, options);

			const { AzureOpenAiChatClient } = await importFoundation();

			const request: AzureOpenAiChatCompletionParameters = {
				messages,
				...(tools.length > 0 ? { tools } : {}),
				...params,
			};

			debugLog({
				requestId,
				kind: "request",
				provider: "foundation-azure-openai",
				model: model.id,
				resourceGroup,
				params,
				messageRoles: messages.map((m) => m.role),
				messages,
			});

			// Name-based deployment resolution: the SDK finds THE foundation
			// deployment serving this model in the resource group. SAP allows
			// only one deployment per (model, version, resource group), so the
			// match is unambiguous — no deployment ID needed.
			const client = new AzureOpenAiChatClient({
				modelName: model.id,
				...(resourceGroup ? { resourceGroup } : {}),
			});

			const response = await client.stream(request, options?.signal);

			let textIndex = -1;
			let thinkingIndex = -1;
			let reasoningField: string | undefined;
			let refusalText = "";
			const toolSlots = new Map<number, ToolCallSlot>();
			let finishReason: string | undefined;

			const closeText = () => {
				if (textIndex < 0) return;
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
			};

			const closeThinking = () => {
				if (thinkingIndex < 0) return;
				const block = output.content[thinkingIndex];
				if (block?.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: block.thinking,
						partial: output,
					});
				}
				thinkingIndex = -1;
			};

			for await (const chunk of response.stream) {
				if (options?.signal?.aborted) break;

				const choice = chunk.findChoiceByIndex(0);
				const rawDelta = (choice?.delta ?? {}) as ExtendedDelta;

				// Reasoning first — providers emit it before visible text, and
				// pi's UI expects the thinking block to precede the text block.
				// (gpt-5* on the direct route are unlikely to pass structured
				// reasoning through, but we handle it for free if they do.)
				const reasoning = pickReasoning(rawDelta, reasoningField);
				if (reasoning) {
					reasoningField = reasoning.field;
					if (thinkingIndex < 0) {
						closeText();
						output.content.push({ type: "thinking", thinking: "" });
						thinkingIndex = output.content.length - 1;
						stream.push({
							type: "thinking_start",
							contentIndex: thinkingIndex,
							partial: output,
						});
					}
					const block = output.content[thinkingIndex];
					if (block?.type === "thinking") {
						block.thinking += reasoning.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: thinkingIndex,
							delta: reasoning.text,
							partial: output,
						});
					}
				}

				const delta = chunk.getDeltaContent();
				if (delta) {
					if (textIndex < 0) {
						closeThinking();
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

				if (
					typeof rawDelta.refusal === "string" &&
					rawDelta.refusal.length > 0
				) {
					refusalText += rawDelta.refusal;
				}

				const toolDeltas = chunk.getDeltaToolCalls();
				if (toolDeltas && toolDeltas.length > 0) {
					closeText();
					closeThinking();

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
							if (td.function?.name && !block.name)
								block.name = td.function.name;

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

				finishReason = latchFinishReason(
					finishReason,
					chunk.getFinishReason() ?? undefined,
				);
			}

			closeText();
			closeThinking();

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
				output.usage = mapUsage(usage);
				calculateCost(model, output.usage);
			}

			// A refusal terminates the turn with no real content. Promote it to a
			// visible error so pi doesn't render an empty assistant turn.
			if (refusalText) {
				output.stopReason = "error";
				output.errorMessage = `Model refused: ${refusalText}`;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}

			output.stopReason = mapFinishReason(
				toolSlots.size > 0
					? "tool_calls"
					: (finishReason ?? response.getFinishReason() ?? undefined),
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
			debugLog({
				requestId,
				kind: "error",
				provider: "foundation-azure-openai",
				model: model.id,
				stopReason: output.stopReason,
				error: output.errorMessage,
			});
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
