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
import { executeRequest } from "@sap-ai-sdk/core";

import { resolveFoundationDeploymentId } from "./foundation-deployment.ts";
import {
	debugLog,
	ensureServiceKey,
	formatError,
	mapUsage,
	resolveResourceGroup,
} from "./stream.ts";
import { mapFinishReason } from "./translate.ts";
import { piContextToVertexGenerateContent } from "./translate-foundation-vertexai.ts";

type VertexGenerateContentResponse = {
	candidates?: Array<{
		content?: {
			role?: string;
			parts?: Array<{
				text?: string;
				thoughtSignature?: string;
				functionCall?: { name?: string; args?: unknown };
			}>;
		};
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
	};
};

export function streamSapFoundationVertexAi(
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
			const deploymentId = await resolveFoundationDeploymentId({
				modelId: model.id,
				executableId: "gcp-vertexai",
				resourceGroup,
			});

			const translated = piContextToVertexGenerateContent(context);
			const maxOutputTokens = options?.maxTokens ?? model.maxTokens;
			const request = {
				...translated,
				generationConfig: {
					maxOutputTokens,
					...(options?.temperature !== undefined
						? { temperature: options.temperature }
						: {}),
					// Gemini 3.x can spend small max-token budgets entirely on
					// thinking. Keep foundation route responsive by default; use
					// orchestration once SAP exposes/validates richer thinking controls.
					thinkingConfig: { thinkingBudget: 0 },
				},
			};

			debugLog({
				requestId,
				kind: "request",
				provider: "foundation-gcp-vertexai",
				model: model.id,
				resourceGroup,
				deploymentId,
				params: request.generationConfig,
				messageRoles: request.contents.map((m) => m.role),
				messages: request.contents,
			});

			const response = await executeRequest(
				{
					url: `/inference/deployments/${deploymentId}/models/${model.id}:generateContent`,
					resourceGroup,
				},
				request,
				{ signal: options?.signal },
			);

			const data = response.data as VertexGenerateContentResponse;
			replayVertexGenerateContentResponse(stream, output, data);

			if (data.usageMetadata) {
				output.usage = mapUsage({
					prompt_tokens: data.usageMetadata.promptTokenCount ?? 0,
					completion_tokens:
						(data.usageMetadata.candidatesTokenCount ?? 0) +
						(data.usageMetadata.thoughtsTokenCount ?? 0),
				});
				calculateCost(model, output.usage);
			}

			const finishReason = data.candidates?.[0]?.finishReason;
			output.stopReason = mapFinishReason(
				finishReason === "MAX_TOKENS" ? "length" : finishReason,
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
				provider: "foundation-gcp-vertexai",
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

function replayVertexGenerateContentResponse(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	data: VertexGenerateContentResponse,
): void {
	const parts = data.candidates?.[0]?.content?.parts ?? [];
	for (const part of parts) {
		if (typeof part.text === "string" && part.text.length > 0) {
			const contentIndex = output.content.length;
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex, partial: output });
			const block = output.content[contentIndex];
			if (block?.type === "text") block.text = part.text;
			stream.push({
				type: "text_delta",
				contentIndex,
				delta: part.text,
				partial: output,
			});
			stream.push({
				type: "text_end",
				contentIndex,
				content: part.text,
				partial: output,
			});
		}

		if (part.functionCall) {
			const contentIndex = output.content.length;
			const providerName = part.functionCall.name ?? "";
			const toolCall = {
				type: "toolCall" as const,
				id: randomUUID(),
				name: normalizeVertexFunctionName(providerName),
				arguments:
					part.functionCall.args && typeof part.functionCall.args === "object"
						? (part.functionCall.args as Record<string, unknown>)
						: {},
				...(part.thoughtSignature
					? { thoughtSignature: part.thoughtSignature }
					: {}),
			};
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({
				type: "toolcall_end",
				contentIndex,
				toolCall,
				partial: output,
			});
		}
	}
}

function normalizeVertexFunctionName(name: string): string {
	const index = name.indexOf(":");
	return index >= 0 ? name.slice(index + 1) : name;
}
