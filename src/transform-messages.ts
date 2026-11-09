import type {
	Api,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai";

// Vendored copy of pi's `@earendil-works/pi-ai/api/transform-messages`.
//
// pi's extension loader (`dist/core/extensions/loader.js`) hands jiti a fixed
// map of pi specifiers, and only these pi-ai entries are in it:
//
//   @earendil-works/pi-ai               -> pi-ai's *compat* entrypoint
//   @earendil-works/pi-ai/compat
//   @earendil-works/pi-ai/oauth
//   @earendil-works/pi-ai/providers/all
//
// How an unmapped specifier behaves depends on how pi was built, and that is the
// trap. The npm build keeps its dependencies on disk, so jiti falls through to
// Node resolution from pi's own tree and `.../api/transform-messages` happens to
// resolve. A bundled build has no such tree — pi-ai is compiled in, the map is
// `VIRTUAL_MODULES`, and there is nothing to fall through to, so the same import
// kills the extension at startup:
//
//   Failed to load extension: Cannot find module
//   '@earendil-works/pi-ai/api/transform-messages'
//
// That is how 0.4.3 shipped: it worked on the maintainer's npm-layout pi and
// broke on a bundled one. Treat the map as the whole contract regardless of
// build.
//
// Importing from the mapped root instead is not an option either —
// `transformMessages` is internal and re-exported from neither the root nor the
// compat entrypoint. Type-only imports are unaffected throughout: they are
// erased before any resolver sees them, which is why the rest of this extension
// names pi-ai freely.
//
// Keep this in sync with pi's implementation when bumping the supported pi
// range. It is byte-identical across pi-ai 0.81.1, 0.83.0 and 0.84.3, and
// `scripts/test-transform-messages.mjs` diffs behaviour against the real module
// whenever it is resolvable (i.e. in this repo's dev install), so drift surfaces
// in `npm test` rather than in a user's session.

const NON_VISION_USER_IMAGE_PLACEHOLDER =
	"(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
	"(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder<T extends TextContent | ImageContent>(
	content: T[],
	placeholder: string,
): T[] {
	const result: T[] = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder } as unknown as T);
			}
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

function downgradeUnsupportedImages(
	messages: Message[],
	model: Model<Api>,
): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}
	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(
					msg.content,
					NON_VISION_USER_IMAGE_PLACEHOLDER,
				),
			};
		}
		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(
					msg.content,
					NON_VISION_TOOL_IMAGE_PLACEHOLDER,
				),
			};
		}
		return msg;
	});
}

// pi's signature takes an optional `normalizeToolCallId`; this extension never
// passes one (SAP's OpenAI-style ids already satisfy Anthropic's
// `^[a-zA-Z0-9_-]{1,64}`), so the parameter and its id-remapping bookkeeping are
// omitted here rather than carried as dead code.
export function transformMessages(
	messages: Message[],
	model: Model<Api>,
): Message[] {
	// Normalize null/undefined content from untyped callers (custom tools,
	// hand-built histories, old session files) so downstream code can rely on the
	// type contract.
	const normalizedMessages = messages.map((msg) =>
		msg.content == null ? { ...msg, content: [] } : msg,
	);
	const imageAwareMessages = downgradeUnsupportedImages(
		normalizedMessages,
		model,
	);

	// First pass: image downgrade (above) plus thinking-block normalisation.
	const transformed = imageAwareMessages.map((msg) => {
		if (msg.role !== "assistant") {
			return msg;
		}
		const assistantMsg = msg;
		const isSameModel =
			assistantMsg.provider === model.provider &&
			assistantMsg.api === model.api &&
			assistantMsg.model === model.id;
		const transformedContent = assistantMsg.content.flatMap<
			TextContent | (typeof assistantMsg.content)[number]
		>((block) => {
			if (block.type === "thinking") {
				// Thinking from another model is dropped. Signatures and encrypted
				// reasoning only work for the model that produced them, and readable
				// thinking sent as plain text reads as part of the visible reply.
				if (!isSameModel) return [];
				// Keep redacted and signed blocks even if the thinking text is empty
				// (OpenAI encrypted reasoning); they are needed for replay.
				if (block.redacted || block.thinkingSignature) return block;
				if (!block.thinking || block.thinking.trim() === "") return [];
				return block;
			}
			if (block.type === "text") {
				if (isSameModel) return block;
				return { type: "text", text: block.text } satisfies TextContent;
			}
			if (block.type === "toolCall" && !isSameModel && block.thoughtSignature) {
				const normalizedToolCall = { ...block };
				delete normalizedToolCall.thoughtSignature;
				return normalizedToolCall;
			}
			return block;
		});
		return { ...assistantMsg, content: transformedContent };
	});

	// Second pass: insert synthetic tool results for orphaned tool calls. This
	// preserves thinking signatures and satisfies API requirements.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					});
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			// Orphaned tool calls from a previous assistant turn resolve here.
			insertSyntheticToolResults();
			// Skip errored/aborted assistant messages entirely. These are incomplete
			// turns that shouldn't be replayed:
			//  - may have partial content (reasoning without message, incomplete
			//    tool calls)
			//  - replaying them can cause API errors (e.g. OpenAI "reasoning without
			//    following item")
			//  - the model should retry from the last valid state
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}
			const toolCalls = msg.content.filter(
				(b): b is ToolCall => b.type === "toolCall",
			);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else {
			// A user message interrupts the tool flow.
			insertSyntheticToolResults();
			result.push(msg);
		}
	}

	// A conversation that ends on unresolved tool calls gets results too.
	insertSyntheticToolResults();
	return result;
}

