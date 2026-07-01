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
import { piContextToBedrockConverse } from "./translate-foundation-bedrock.ts";

type BedrockConverseResponse = {
	output?: {
		message?: {
			role?: string;
			content?: Array<{
				text?: string;
				toolUse?: {
					toolUseId?: string;
					name?: string;
					input?: unknown;
				};
			}>;
		};
	};
	stopReason?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		cacheReadInputTokens?: number;
		cacheReadInputTokenCount?: number;
		cacheWriteInputTokens?: number;
		cacheWriteInputTokenCount?: number;
	};
};

export function streamSapFoundationBedrock(
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
				executableId: "aws-bedrock",
				resourceGroup,
			});

			const translated = piContextToBedrockConverse(context);
			const maxTokens = options?.maxTokens ?? model.maxTokens;
			const request = {
				...translated,
				inferenceConfig: {
					maxTokens,
					...(options?.temperature !== undefined
						? { temperature: options.temperature }
						: {}),
				},
			};

			debugLog({
				requestId,
				kind: "request",
				provider: "foundation-aws-bedrock",
				model: model.id,
				resourceGroup,
				deploymentId,
				params: request.inferenceConfig,
				messageRoles: request.messages.map((m) => m.role),
				messages: request.messages,
			});

			const response = await executeRequest(
				{
					url: `/inference/deployments/${deploymentId}/converse`,
					resourceGroup,
				},
				request,
				{ signal: options?.signal },
			);

			const data = response.data as BedrockConverseResponse;
			replayBedrockConverseResponse(stream, output, data);

			if (data.usage) {
				output.usage = mapUsage({
					prompt_tokens: data.usage.inputTokens ?? 0,
					completion_tokens: data.usage.outputTokens ?? 0,
					cache_read_input_tokens:
						data.usage.cacheReadInputTokens ??
						data.usage.cacheReadInputTokenCount ??
						0,
					cache_creation_input_tokens:
						data.usage.cacheWriteInputTokens ??
						data.usage.cacheWriteInputTokenCount ??
						0,
				});
				calculateCost(model, output.usage);
			}

			output.stopReason = mapFinishReason(
				data.stopReason === "max_tokens" ? "length" : data.stopReason,
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
				provider: "foundation-aws-bedrock",
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

function replayBedrockConverseResponse(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	data: BedrockConverseResponse,
): void {
	const blocks = data.output?.message?.content ?? [];
	for (const block of blocks) {
		if (typeof block.text === "string" && block.text.length > 0) {
			const contentIndex = output.content.length;
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex, partial: output });
			const outBlock = output.content[contentIndex];
			if (outBlock?.type === "text") outBlock.text = block.text;
			stream.push({
				type: "text_delta",
				contentIndex,
				delta: block.text,
				partial: output,
			});
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
		}

		if (block.toolUse) {
			const contentIndex = output.content.length;
			const toolCall = {
				type: "toolCall" as const,
				id: block.toolUse.toolUseId ?? randomUUID(),
				name: block.toolUse.name ?? "",
				arguments:
					block.toolUse.input && typeof block.toolUse.input === "object"
						? (block.toolUse.input as Record<string, unknown>)
						: {},
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
