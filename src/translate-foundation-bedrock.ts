import type {
	AssistantMessage,
	Context,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

export type BedrockConverseContentBlock =
	| { text: string }
	| {
			image: {
				format: string;
				source: { bytes: string };
			};
	  }
	| {
			toolUse: {
				toolUseId: string;
				name: string;
				input: unknown;
			};
	  }
	| {
			toolResult: {
				toolUseId: string;
				content: Array<{ text: string }>;
				status?: "success" | "error";
			};
	  };

export type BedrockConverseMessage = {
	role: "user" | "assistant";
	content: BedrockConverseContentBlock[];
};

export function piContextToBedrockConverse(context: Context): {
	system?: Array<{ text: string }>;
	messages: BedrockConverseMessage[];
} {
	const messages: BedrockConverseMessage[] = [];

	for (const msg of context.messages) {
		const translated = piMessageToBedrockConverse(msg);
		if (translated) messages.push(translated);
	}

	return {
		...(context.systemPrompt ? { system: [{ text: context.systemPrompt }] } : {}),
		messages: coalesceAdjacentMessages(messages),
	};
}

function piMessageToBedrockConverse(
	msg: Message,
): BedrockConverseMessage | undefined {
	switch (msg.role) {
		case "user":
			return piUserToBedrockConverse(msg);
		case "assistant":
			return piAssistantToBedrockConverse(msg);
		case "toolResult":
			return piToolResultToBedrockConverse(msg);
	}
}

function piUserToBedrockConverse(msg: UserMessage): BedrockConverseMessage {
	if (typeof msg.content === "string") {
		return { role: "user", content: [{ text: msg.content }] };
	}

	const content = msg.content.map((part): BedrockConverseContentBlock => {
		if (part.type === "text") return { text: part.text };
		return {
			image: {
				format: imageFormatFromMimeType(part.mimeType),
				source: { bytes: part.data },
			},
		};
	});

	return { role: "user", content: content.length > 0 ? content : [{ text: " " }] };
}

function piAssistantToBedrockConverse(
	msg: AssistantMessage,
): BedrockConverseMessage {
	const content: BedrockConverseContentBlock[] = [];

	for (const block of msg.content) {
		if (block.type === "text" && block.text) {
			content.push({ text: block.text });
		} else if (block.type === "toolCall") {
			content.push({
				toolUse: {
					toolUseId: block.id,
					name: block.name,
					input: block.arguments,
				},
			});
		}
	}

	return {
		role: "assistant",
		content: content.length > 0 ? content : [{ text: " " }],
	};
}

function piToolResultToBedrockConverse(
	msg: ToolResultMessage,
): BedrockConverseMessage {
	const text = toolResultText(msg) || " ";
	return {
		role: "user",
		content: [
			{
				toolResult: {
					toolUseId: msg.toolCallId,
					content: [{ text }],
					status: msg.isError ? "error" : "success",
				},
			},
			...toolResultImagesAsUserContent(msg),
		],
	};
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function toolResultImagesAsUserContent(
	msg: ToolResultMessage,
): BedrockConverseContentBlock[] {
	return msg.content
		.filter(
			(part): part is { type: "image"; data: string; mimeType: string } =>
				part.type === "image",
		)
		.map((part) => ({
			image: {
				format: imageFormatFromMimeType(part.mimeType),
				source: { bytes: part.data },
			},
		}));
}

function imageFormatFromMimeType(mimeType: string): string {
	const format = mimeType.split("/")[1]?.toLowerCase();
	if (format === "jpg") return "jpeg";
	if (format === "jpeg" || format === "png" || format === "gif" || format === "webp") {
		return format;
	}
	return "png";
}

function coalesceAdjacentMessages(
	messages: BedrockConverseMessage[],
): BedrockConverseMessage[] {
	const result: BedrockConverseMessage[] = [];
	for (const msg of messages) {
		const previous = result[result.length - 1];
		if (previous && previous.role === msg.role) {
			previous.content.push(...msg.content);
		} else {
			result.push({ role: msg.role, content: [...msg.content] });
		}
	}
	return result;
}
