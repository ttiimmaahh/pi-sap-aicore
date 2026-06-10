import type {
	AssistantMessage,
	Context,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AzureOpenAiChatCompletionRequestAssistantMessage,
	AzureOpenAiChatCompletionRequestMessage,
	AzureOpenAiChatCompletionRequestToolMessage,
	AzureOpenAiChatCompletionRequestUserMessage,
	AzureOpenAiChatCompletionTool,
} from "@sap-ai-sdk/foundation-models";

// pi `Context` → Azure OpenAI chat request. This is the orchestration
// `translate.ts` minus the Anthropic `cache_control` tagging — that is an
// Anthropic-via-orchestration concern and has no meaning on the direct
// OpenAI endpoint, so the foundation path is strictly simpler. The Azure
// message/content/tool shapes are the standard OpenAI ones (each carries an
// `& Record<string, any>` escape hatch), so inline literals type-check
// against the message-level types without importing the content-part types
// (which the package doesn't re-export from its root).
export function piContextToAzureOpenAi(context: Context): {
	messages: AzureOpenAiChatCompletionRequestMessage[];
	tools: AzureOpenAiChatCompletionTool[];
} {
	const messages: AzureOpenAiChatCompletionRequestMessage[] = [];

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	const pi = context.messages;
	for (let i = 0; i < pi.length; i++) {
		const msg = pi[i];

		if (msg.role === "assistant") {
			const assistant = piAssistantToAzureOpenAi(msg);
			const toolCalls = assistant.tool_calls ?? [];
			if (toolCalls.length === 0) {
				messages.push(assistant);
				continue;
			}

			messages.push(assistant);

			// OpenAI/Azure require every assistant tool_call to be followed
			// immediately by role:"tool" messages for *all* tool_call_ids.
			// Pi stores each tool result as a separate top-level message, and this
			// translator may need to hoist image results into synthetic user messages.
			// If we translate tool results one-by-one, multiple screenshot-producing
			// tool results become: tool, user(image), tool — and Azure rejects the
			// second tool call as unanswered. Batch all contiguous tool results here:
			// assistant(tool_calls), all tool messages, then any hoisted images.
			const expectedIds: string[] = [];
			for (const toolCall of toolCalls) expectedIds.push(toolCall.id);
			const expected = new Set(expectedIds);
			const byId = new Map<string, AzureToolResultParts>();
			const orphaned: AzureOpenAiChatCompletionRequestUserMessage[] = [];

			let j = i + 1;
			while (j < pi.length) {
				const toolResult = pi[j];
				if (toolResult.role !== "toolResult") break;
				if (
					expected.has(toolResult.toolCallId) &&
					!byId.has(toolResult.toolCallId)
				) {
					byId.set(
						toolResult.toolCallId,
						piToolResultToAzureOpenAiParts(toolResult),
					);
				} else {
					orphaned.push(...piToolResultToSyntheticUserMessages(toolResult));
				}
				j++;
			}

			const imageMessages: AzureOpenAiChatCompletionRequestUserMessage[] = [];
			for (const id of expectedIds) {
				const translated = byId.get(id);
				if (translated) {
					messages.push(translated.toolMessage);
					imageMessages.push(...translated.imageMessages);
				} else {
					messages.push(missingToolResultMessage(id));
				}
			}
			messages.push(...imageMessages, ...orphaned);
			i = j - 1;
			continue;
		}

		if (msg.role === "toolResult") {
			// A standalone tool message is invalid for OpenAI. Keep the information
			// available to the model, but present it as user-visible transcript text.
			messages.push(...piToolResultToSyntheticUserMessages(msg));
			continue;
		}

		messages.push(piUserToAzureOpenAi(msg));
	}

	const tools = (context.tools ?? []).map(piToolToAzureOpenAi);
	return { messages, tools };
}

function piUserToAzureOpenAi(
	msg: UserMessage,
): AzureOpenAiChatCompletionRequestUserMessage {
	if (typeof msg.content === "string") {
		return { role: "user", content: msg.content };
	}

	const items = msg.content.map((part) =>
		part.type === "text"
			? { type: "text" as const, text: part.text }
			: {
					type: "image_url" as const,
					image_url: { url: `data:${part.mimeType};base64,${part.data}` },
				},
	);
	return { role: "user", content: items };
}

function piAssistantToAzureOpenAi(
	msg: AssistantMessage,
): AzureOpenAiChatCompletionRequestAssistantMessage {
	let text = "";
	const toolCalls: {
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}[] = [];

	for (const block of msg.content) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "toolCall") {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: JSON.stringify(block.arguments),
				},
			});
		}
	}

	// OpenAI rejects an assistant message with neither content nor tool_calls.
	// Match the orchestration path: substitute a single space when there is no
	// text and no tool call, so conversation alternation stays 1:1 with pi's log.
	const result: AzureOpenAiChatCompletionRequestAssistantMessage = {
		role: "assistant",
		content: text || (toolCalls.length === 0 ? " " : ""),
	};
	if (toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

type AzureToolResultParts = {
	toolMessage: AzureOpenAiChatCompletionRequestToolMessage;
	imageMessages: AzureOpenAiChatCompletionRequestUserMessage[];
};

function piToolResultToAzureOpenAiParts(
	msg: ToolResultMessage,
): AzureToolResultParts {
	const text = toolResultText(msg);
	const imageMessages = toolResultImages(msg).map((img) => ({
		role: "user" as const,
		content: [
			{
				type: "image_url" as const,
				image_url: { url: `data:${img.mimeType};base64,${img.data}` },
			},
		],
	}));

	return {
		toolMessage: {
			role: "tool",
			tool_call_id: msg.toolCallId,
			content:
				text ||
				(imageMessages.length > 0
					? "Tool returned image content; image(s) follow in the next user message."
					: " "),
		},
		imageMessages,
	};
}

function missingToolResultMessage(
	toolCallId: string,
): AzureOpenAiChatCompletionRequestToolMessage {
	return {
		role: "tool",
		tool_call_id: toolCallId,
		content: "[Tool result missing from local transcript.]",
	};
}

function piToolResultToSyntheticUserMessages(
	msg: ToolResultMessage,
): AzureOpenAiChatCompletionRequestUserMessage[] {
	const content = [
		{
			type: "text" as const,
			text: `Tool result for ${msg.toolName} (${msg.toolCallId}):\n${
				toolResultText(msg) || "[no textual output]"
			}`,
		},
		...toolResultImages(msg).map((img) => ({
			type: "image_url" as const,
			image_url: { url: `data:${img.mimeType};base64,${img.data}` },
		})),
	];
	return [{ role: "user", content }];
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function toolResultImages(
	msg: ToolResultMessage,
): { type: "image"; data: string; mimeType: string }[] {
	return msg.content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } =>
			part.type === "image",
	);
}

function piToolToAzureOpenAi(tool: Tool): AzureOpenAiChatCompletionTool {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as unknown as Record<string, unknown>,
		},
	};
}
