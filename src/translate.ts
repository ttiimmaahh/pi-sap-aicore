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
	messagesHistory: ChatMessage[];
	tools: ChatCompletionTool[];
} {
	const messagesHistory: ChatMessage[] = [];

	if (context.systemPrompt) {
		messagesHistory.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		const converted = piMessageToOrchestration(msg);
		if (converted) messagesHistory.push(converted);
	}

	const tools = (context.tools ?? []).map(piToolToOrchestration);

	return { messagesHistory, tools };
}

function piMessageToOrchestration(msg: Message): ChatMessage | null {
	switch (msg.role) {
		case "user":
			return piUserToOrchestration(msg);
		case "assistant":
			return piAssistantToOrchestration(msg);
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

function piToolResultToOrchestration(msg: ToolResultMessage): ChatMessage {
	const text = msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	return {
		role: "tool",
		tool_call_id: msg.toolCallId,
		content: text,
	};
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
