import type {
	AssistantMessage,
	Context,
	Message,
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

	for (const msg of context.messages) {
		messages.push(...piMessageToAzureOpenAi(msg));
	}

	const tools = (context.tools ?? []).map(piToolToAzureOpenAi);
	return { messages, tools };
}

function piMessageToAzureOpenAi(
	msg: Message,
): AzureOpenAiChatCompletionRequestMessage[] {
	switch (msg.role) {
		case "user":
			return [piUserToAzureOpenAi(msg)];
		case "assistant":
			return [piAssistantToAzureOpenAi(msg)];
		case "toolResult":
			return piToolResultToAzureOpenAi(msg);
	}
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

function piToolResultToAzureOpenAi(
	msg: ToolResultMessage,
): AzureOpenAiChatCompletionRequestMessage[] {
	const text = msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const toolMessage: AzureOpenAiChatCompletionRequestToolMessage = {
		role: "tool",
		tool_call_id: msg.toolCallId,
		content: text,
	};

	// The tool message schema is text-only, so image blocks produced by pi
	// tools (e.g. `read` on an image) are hoisted into a synthetic user message
	// right after the tool result so vision-capable models still see the bytes.
	const images = msg.content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } =>
			part.type === "image",
	);
	if (images.length === 0) return [toolMessage];

	const imageItems = images.map((img) => ({
		type: "image_url" as const,
		image_url: { url: `data:${img.mimeType};base64,${img.data}` },
	}));
	const imageMessage: AzureOpenAiChatCompletionRequestUserMessage = {
		role: "user",
		content: imageItems,
	};
	return [toolMessage, imageMessage];
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
