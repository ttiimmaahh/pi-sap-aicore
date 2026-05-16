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
	AssistantChatMessage,
	ChatCompletionTool,
	ChatMessage,
	UserChatMessageContent,
	UserChatMessageContentItem,
} from "@sap-ai-sdk/orchestration";

export function piContextToOrchestration(context: Context): {
	messages: ChatMessage[];
	tools: ChatCompletionTool[];
} {
	const messages: ChatMessage[] = [];

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		messages.push(...piMessageToOrchestration(msg));
	}

	const tools = (context.tools ?? []).map(piToolToOrchestration);

	return { messages, tools };
}

function piMessageToOrchestration(msg: Message): ChatMessage[] {
	switch (msg.role) {
		case "user":
			return [piUserToOrchestration(msg)];
		case "assistant":
			return [piAssistantToOrchestration(msg)];
		case "toolResult":
			return piToolResultToOrchestration(msg);
	}
}

function piUserToOrchestration(msg: UserMessage): ChatMessage {
	if (typeof msg.content === "string") {
		return { role: "user", content: msg.content };
	}

	const items: UserChatMessageContentItem[] = msg.content.map((part) => {
		if (part.type === "text") {
			return { type: "text", text: part.text };
		}
		return {
			type: "image_url",
			image_url: { url: `data:${part.mimeType};base64,${part.data}` },
		};
	});

	return { role: "user", content: items as UserChatMessageContent };
}

function piAssistantToOrchestration(msg: AssistantMessage): ChatMessage {
	let text = "";
	const toolCalls: NonNullable<AssistantChatMessage["tool_calls"]> = [];

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

	const result: AssistantChatMessage = { role: "assistant", content: text };
	if (toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

function piToolResultToOrchestration(msg: ToolResultMessage): ChatMessage[] {
	const text = msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const toolMessage: ChatMessage = {
		role: "tool",
		tool_call_id: msg.toolCallId,
		content: text,
	};

	// SAP's ToolChatMessage.content schema is text-only (`string |
	// TextContent[]`), so any image blocks produced by pi tools (most
	// commonly the `read` tool on an image file) get silently dropped.
	// Hoist them into a synthetic user message immediately after the
	// tool result so vision-capable models actually see the bytes.
	const images = msg.content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } =>
			part.type === "image",
	);
	if (images.length === 0) return [toolMessage];

	const imageItems: UserChatMessageContentItem[] = images.map((img) => ({
		type: "image_url",
		image_url: { url: `data:${img.mimeType};base64,${img.data}` },
	}));
	const imageMessage: ChatMessage = {
		role: "user",
		content: imageItems as UserChatMessageContent,
	};
	return [toolMessage, imageMessage];
}

function piToolToOrchestration(tool: Tool): ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as unknown as Record<string, unknown>,
		},
	};
}

export function mapFinishReason(
	reason: string | undefined,
): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		default:
			return "stop";
	}
}
