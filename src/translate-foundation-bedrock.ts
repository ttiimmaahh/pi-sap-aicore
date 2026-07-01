import type {
	AssistantMessage,
	Context,
	TextContent,
	Tool,
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

export type BedrockToolConfig = {
	tools: Array<{
		toolSpec: {
			name: string;
			description: string;
			inputSchema: { json: Record<string, unknown> };
		};
	}>;
};

export function piContextToBedrockConverse(context: Context): {
	system?: Array<{ text: string }>;
	messages: BedrockConverseMessage[];
	toolConfig?: BedrockToolConfig;
} {
	const messages: BedrockConverseMessage[] = [];
	const pi = context.messages;

	for (let i = 0; i < pi.length; i++) {
		const msg = pi[i];

		if (msg.role === "assistant") {
			const assistant = piAssistantToBedrockConverse(msg);
			const toolUseIds = assistant.content.flatMap((block) =>
				"toolUse" in block ? [block.toolUse.toolUseId] : [],
			);
			if (toolUseIds.length === 0) {
				messages.push(assistant);
				continue;
			}

			messages.push(assistant);

			// Bedrock/Anthropic require the next user message after assistant
			// toolUse blocks to begin with the corresponding toolResult blocks,
			// one per toolUseId. Pi stores tool results as separate top-level
			// messages, and screenshot tool results may contain images. If those
			// image blocks are interleaved between toolResult blocks after role
			// coalescing, Anthropic rejects the request with:
			// "tool_use ids were found without tool_result blocks immediately after".
			// Batch all contiguous expected tool results first, then append any
			// images/orphaned result transcript content after the required prefix.
			const expected = new Set(toolUseIds);
			const byId = new Map<string, BedrockToolResultParts>();
			const orphaned: BedrockConverseContentBlock[] = [];

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
						piToolResultToBedrockContentParts(toolResult),
					);
				} else {
					orphaned.push(...piToolResultToSyntheticUserContent(toolResult));
				}
				j++;
			}

			const content: BedrockConverseContentBlock[] = [];
			const images: BedrockConverseContentBlock[] = [];
			for (const id of toolUseIds) {
				const translated = byId.get(id);
				if (translated) {
					content.push(translated.toolResult);
					images.push(...translated.images);
				} else {
					content.push(missingToolResultBlock(id));
				}
			}
			messages.push({
				role: "user",
				content: [...content, ...images, ...orphaned],
			});
			i = j - 1;
			continue;
		}

		if (msg.role === "toolResult") {
			// A standalone toolResult block is invalid in Bedrock/Anthropic. Keep
			// the information available to the model as normal user-visible text.
			messages.push({
				role: "user",
				content: piToolResultToSyntheticUserContent(msg),
			});
			continue;
		}

		messages.push(piUserToBedrockConverse(msg));
	}

	const tools = (context.tools ?? []).map(piToolToBedrockToolSpec);
	return {
		...(context.systemPrompt
			? { system: [{ text: context.systemPrompt }] }
			: {}),
		messages: coalesceAdjacentMessages(messages),
		...(tools.length > 0 ? { toolConfig: { tools } } : {}),
	};
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

	return {
		role: "user",
		content: content.length > 0 ? content : [{ text: " " }],
	};
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

type BedrockToolResultParts = {
	toolResult: BedrockConverseContentBlock;
	images: BedrockConverseContentBlock[];
};

function piToolResultToBedrockContentParts(
	msg: ToolResultMessage,
): BedrockToolResultParts {
	return {
		toolResult: bedrockToolResultBlock(
			msg.toolCallId,
			toolResultText(msg) || " ",
			msg.isError,
		),
		images: toolResultImagesAsUserContent(msg),
	};
}

function missingToolResultBlock(
	toolUseId: string,
): BedrockConverseContentBlock {
	return bedrockToolResultBlock(
		toolUseId,
		`Tool result missing for ${toolUseId}.`,
		true,
	);
}

function bedrockToolResultBlock(
	toolUseId: string,
	text: string,
	isError: boolean,
): BedrockConverseContentBlock {
	return {
		toolResult: {
			toolUseId,
			content: [{ text }],
			status: isError ? "error" : "success",
		},
	};
}

function piToolResultToSyntheticUserContent(
	msg: ToolResultMessage,
): BedrockConverseContentBlock[] {
	return [
		{
			text:
				`Tool result for ${msg.toolName} (${msg.toolCallId})` +
				`${msg.isError ? " failed" : ""}:\n${toolResultText(msg) || " "}`,
		},
		...toolResultImagesAsUserContent(msg),
	];
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
	if (
		format === "jpeg" ||
		format === "png" ||
		format === "gif" ||
		format === "webp"
	) {
		return format;
	}
	return "png";
}

function piToolToBedrockToolSpec(
	tool: Tool,
): BedrockToolConfig["tools"][number] {
	return {
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: {
				json: tool.parameters as unknown as Record<string, unknown>,
			},
		},
	};
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
