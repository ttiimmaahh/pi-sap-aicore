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

// Anthropic prompt caching via SAP orchestration is undocumented. SAP's
// ChatMessage schemas are strictly typed (no Record<string,any> escape
// hatch on content), `cache_control` appears nowhere in
// @sap-ai-sdk/orchestration, and the orchestration server may reject
// unknown fields with a 400. Opt-in via PI_SAP_AICORE_CACHE_CONTROL=1 so
// users can probe their own tenant without forcing the risk on everyone
// — if SAP accepts it, `cacheRead`/`cacheWrite` in the Usage block start
// reporting non-zero numbers and pi's cost line drops ~10× on cached
// turns. If SAP rejects it, the error chain will say so.
const CACHE_CONTROL_ENABLED =
	process.env.PI_SAP_AICORE_CACHE_CONTROL === "1";

type CacheControl = { type: "ephemeral" };
const EPHEMERAL: CacheControl = { type: "ephemeral" };

export function piContextToOrchestration(context: Context): {
	messages: ChatMessage[];
	tools: ChatCompletionTool[];
} {
	const messages: ChatMessage[] = [];

	if (context.systemPrompt) {
		messages.push(
			tagCacheControl(
				{ role: "system", content: context.systemPrompt },
				CACHE_CONTROL_ENABLED,
			),
		);
	}

	const pi = context.messages;
	// Anthropic caches up to 4 breakpoints; tagging the LAST user message
	// (after the system prompt) is the standard "keep the long prefix
	// cached" pattern. We tag at most 1 here for safety; expand later
	// once SAP behaviour is confirmed.
	const lastUserIdx = lastIndexWhere(pi, (m) => m.role === "user");
	for (let i = 0; i < pi.length; i++) {
		const translated = piMessageToOrchestration(pi[i]);
		const tagLast = CACHE_CONTROL_ENABLED && i === lastUserIdx;
		if (tagLast && translated.length > 0) {
			translated[translated.length - 1] = tagCacheControl(
				translated[translated.length - 1],
				true,
			);
		}
		messages.push(...translated);
	}

	const tools = (context.tools ?? []).map(piToolToOrchestration);

	return { messages, tools };
}

function lastIndexWhere<T>(arr: T[], pred: (t: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
	return -1;
}

// Tag a translated message's last text content with Anthropic's
// `cache_control: {type: "ephemeral"}`. Casts through `any` because
// SAP's typings forbid it (Anthropic-native field that SAP doesn't
// expose in its schema — see note at top of file).
function tagCacheControl(msg: ChatMessage, enabled: boolean): ChatMessage {
	if (!enabled) return msg;
	if (typeof msg.content === "string") {
		return {
			...msg,
			content: [
				{ type: "text", text: msg.content, cache_control: EPHEMERAL } as any,
			],
		} as ChatMessage;
	}
	if (Array.isArray(msg.content) && msg.content.length > 0) {
		const items = msg.content.slice();
		const last = items[items.length - 1] as any;
		items[items.length - 1] = { ...last, cache_control: EPHEMERAL };
		return { ...msg, content: items } as ChatMessage;
	}
	return msg;
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
