import type {
	AssistantMessage,
	Context,
	Message,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

export type VertexPart =
	| { text: string }
	| { inlineData: { mimeType: string; data: string } }
	| { functionCall: { name: string; args: unknown }; thoughtSignature?: string }
	| { functionResponse: { name: string; response: Record<string, unknown> } };

export type VertexContent = {
	role: "user" | "model";
	parts: VertexPart[];
};

export type VertexTool = {
	functionDeclarations: Array<{
		name: string;
		description: string;
		// Gemini's `parameters` field is a restricted OpenAPI 3.0 Schema subset
		// that rejects `const` and non-string `enum` values. `parametersJsonSchema`
		// accepts full JSON Schema (anyOf/oneOf/const/boolean enums), which is what
		// pi tool definitions actually use. See pi-ai google-shared convertTools.
		parametersJsonSchema: Record<string, unknown>;
	}>;
};

export function piContextToVertexGenerateContent(context: Context): {
	systemInstruction?: { parts: Array<{ text: string }> };
	contents: VertexContent[];
	tools?: VertexTool[];
} {
	const contents: VertexContent[] = [];

	for (const msg of context.messages) {
		const translated = piMessageToVertexContent(msg);
		if (translated) contents.push(translated);
	}

	const functionDeclarations = (context.tools ?? []).map(
		piToolToVertexFunctionDeclaration,
	);
	return {
		...(context.systemPrompt
			? { systemInstruction: { parts: [{ text: context.systemPrompt }] } }
			: {}),
		// Degenerate guard: if every message was dropped as empty, Gemini still
		// requires at least one content entry.
		contents:
			contents.length > 0
				? coalesceAdjacentContents(contents)
				: [{ role: "user", parts: [{ text: "(no conversation content)" }] }],
		...(functionDeclarations.length > 0
			? { tools: [{ functionDeclarations }] }
			: {}),
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

// Mirrors the Bedrock translator: drop empty/whitespace-only text parts and
// messages left with no parts (errored turns persist with content: [],
// thinking-only turns carry no text) instead of emitting a whitespace
// placeholder. See translate-foundation-bedrock.ts for the Anthropic
// rejection this class of payload causes; Gemini gets the same treatment for
// symmetry and to avoid burning tokens on placeholder turns.
function piUserToVertexContent(msg: UserMessage): VertexContent | undefined {
	if (typeof msg.content === "string") {
		if (msg.content.trim().length === 0) return undefined;
		return { role: "user", parts: [{ text: msg.content }] };
	}

	const parts = msg.content.flatMap((part): VertexPart[] => {
		if (part.type === "text") {
			return part.text.trim().length > 0 ? [{ text: part.text }] : [];
		}
		return [{ inlineData: { mimeType: part.mimeType, data: part.data } }];
	});

	return parts.length > 0 ? { role: "user", parts } : undefined;
}

function piAssistantToVertexContent(
	msg: AssistantMessage,
): VertexContent | undefined {
	const parts: VertexPart[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text.trim().length > 0) {
			parts.push({ text: block.text });
		} else if (block.type === "toolCall") {
			parts.push({
				functionCall: {
					name: block.name,
					args: block.arguments,
				},
				...(block.thoughtSignature
					? { thoughtSignature: block.thoughtSignature }
					: {}),
			});
		}
	}
	return parts.length > 0 ? { role: "model", parts } : undefined;
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

function piToolToVertexFunctionDeclaration(
	tool: Tool,
): VertexTool["functionDeclarations"][number] {
	return {
		name: tool.name,
		description: tool.description,
		// Use `parametersJsonSchema` (full JSON Schema) instead of the legacy
		// `parameters` OpenAPI subset. The latter rejects `const` and non-string
		// `enum` values that pi tool schemas commonly contain, causing HTTP 400
		// "Unknown name const" / "enum[0] (TYPE_STRING)" errors from Gemini.
		parametersJsonSchema: tool.parameters as unknown as Record<string, unknown>,
	};
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
