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
			// Errored turns (content: []) and thinking-only turns translate to
			// nothing Anthropic accepts — drop them; coalescing re-merges the
			// surrounding user messages. See piAssistantToBedrockConverse.
			if (!assistant) continue;
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

		const user = piUserToBedrockConverse(msg);
		if (user) messages.push(user);
	}

	const tools = (context.tools ?? []).map(piToolToBedrockToolSpec);
	const coalesced = coalesceAdjacentMessages(messages);
	return {
		...(context.systemPrompt
			? { system: [{ text: context.systemPrompt }] }
			: {}),
		// Degenerate guard: if every message was dropped as empty, Bedrock still
		// requires at least one message.
		messages:
			coalesced.length > 0
				? coalesced
				: [{ role: "user", content: [{ text: "(no conversation content)" }] }],
		...(tools.length > 0 ? { toolConfig: { tools } } : {}),
	};
}

// Anthropic (via Bedrock Converse) rejects any text content block that is
// empty or whitespace-only: "messages: text content blocks must contain
// non-whitespace text". Pi contexts legitimately contain such blocks — errored
// assistant turns persist with content: [], thinking-only turns carry no text,
// and replayed histories can hold empty text parts — so both translators drop
// them (returning undefined for messages left with no content) instead of
// emitting the old `{ text: " " }` placeholder, which was itself
// whitespace-only and poisoned every request in the conversation.
function piUserToBedrockConverse(
	msg: UserMessage,
): BedrockConverseMessage | undefined {
	if (typeof msg.content === "string") {
		if (msg.content.trim().length === 0) return undefined;
		return { role: "user", content: [{ text: msg.content }] };
	}

	const content = msg.content.flatMap(
		(part): BedrockConverseContentBlock[] => {
			if (part.type === "text") {
				return part.text.trim().length > 0 ? [{ text: part.text }] : [];
			}
			return [
				{
					image: {
						format: imageFormatFromMimeType(part.mimeType),
						source: { bytes: part.data },
					},
				},
			];
		},
	);

	return content.length > 0 ? { role: "user", content } : undefined;
}

function piAssistantToBedrockConverse(
	msg: AssistantMessage,
): BedrockConverseMessage | undefined {
	const content: BedrockConverseContentBlock[] = [];

	for (const block of msg.content) {
		if (block.type === "text" && block.text.trim().length > 0) {
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

	return content.length > 0 ? { role: "assistant", content } : undefined;
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
			// Non-whitespace fallback: Anthropic's text-block validation applies
			// inside tool_result content too.
			toolResultText(msg).trim() || "(empty result)",
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
