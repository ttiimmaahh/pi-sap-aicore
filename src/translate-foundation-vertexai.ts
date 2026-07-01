import type {
	AssistantMessage,
	Context,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

export type VertexPart =
	| { text: string }
	| { inlineData: { mimeType: string; data: string } }
	| { functionCall: { name: string; args: unknown } }
	| { functionResponse: { name: string; response: Record<string, unknown> } };

export type VertexContent = {
	role: "user" | "model";
	parts: VertexPart[];
};

export function piContextToVertexGenerateContent(context: Context): {
	systemInstruction?: { parts: Array<{ text: string }> };
	contents: VertexContent[];
} {
	const contents: VertexContent[] = [];

	for (const msg of context.messages) {
		const translated = piMessageToVertexContent(msg);
		if (translated) contents.push(translated);
	}

	return {
		...(context.systemPrompt
			? { systemInstruction: { parts: [{ text: context.systemPrompt }] } }
			: {}),
		contents: coalesceAdjacentContents(contents),
	};
}

function piMessageToVertexContent(msg: Message): VertexContent | undefined {
	switch (msg.role) {
		case "user":
			return piUserToVertexContent(msg);
		case "assistant":
			return piAssistantToVertexContent(msg);
		case "toolResult":
			return piToolResultToVertexContent(msg);
	}
}

function piUserToVertexContent(msg: UserMessage): VertexContent {
	if (typeof msg.content === "string") {
		return { role: "user", parts: [{ text: msg.content }] };
	}

	const parts = msg.content.map((part): VertexPart => {
		if (part.type === "text") return { text: part.text };
		return { inlineData: { mimeType: part.mimeType, data: part.data } };
	});

	return { role: "user", parts: parts.length > 0 ? parts : [{ text: " " }] };
}

function piAssistantToVertexContent(msg: AssistantMessage): VertexContent {
	const parts: VertexPart[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) {
			parts.push({ text: block.text });
		} else if (block.type === "toolCall") {
			parts.push({
				functionCall: { name: block.name, args: block.arguments },
			});
		}
	}
	return { role: "model", parts: parts.length > 0 ? parts : [{ text: " " }] };
}

function piToolResultToVertexContent(msg: ToolResultMessage): VertexContent {
	return {
		role: "user",
		parts: [
			{
				functionResponse: {
					name: msg.toolName ?? msg.toolCallId,
					response: {
						content: toolResultText(msg) || " ",
						...(msg.isError ? { error: true } : {}),
					},
				},
			},
			...toolResultImagesAsUserParts(msg),
		],
	};
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function toolResultImagesAsUserParts(msg: ToolResultMessage): VertexPart[] {
	return msg.content
		.filter(
			(part): part is { type: "image"; data: string; mimeType: string } =>
				part.type === "image",
		)
		.map((part) => ({
			inlineData: { mimeType: part.mimeType, data: part.data },
		}));
}

function coalesceAdjacentContents(contents: VertexContent[]): VertexContent[] {
	const result: VertexContent[] = [];
	for (const content of contents) {
		const previous = result[result.length - 1];
		if (previous && previous.role === content.role) {
			previous.parts.push(...content.parts);
		} else {
			result.push({ role: content.role, parts: [...content.parts] });
		}
	}
	return result;
}
