#!/usr/bin/env node
// Offline regression test for empty/whitespace-only content blocks.
//
// Anthropic (via Bedrock Converse) rejects any text content block that is
// empty or whitespace-only: "messages: text content blocks must contain
// non-whitespace text". Pi contexts legitimately contain such shapes —
// errored assistant turns persist with content: [], thinking-only turns
// carry no text — and the translators used to emit a `{ text: " " }`
// placeholder for them, which is itself whitespace-only and poisoned every
// subsequent request in the conversation. The translators must drop those
// messages (coalescing re-merges the neighbours) and never emit a text block
// without non-whitespace text. This test makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { piContextToBedrockConverse } = await import(
	pathToFileURL(join(ROOT, "src/translate-foundation-bedrock.ts")).href
);
const { piContextToVertexGenerateContent } = await import(
	pathToFileURL(join(ROOT, "src/translate-foundation-vertexai.ts")).href
);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

function bedrockTextBlocks(payload) {
	return payload.messages.flatMap((message) =>
		message.content.flatMap((block) => {
			const texts = [];
			if ("text" in block) texts.push(block.text);
			if ("toolResult" in block) {
				for (const part of block.toolResult.content) {
					if ("text" in part) texts.push(part.text);
				}
			}
			return texts;
		}),
	);
}

function vertexTextParts(payload) {
	return payload.contents.flatMap((content) =>
		content.parts.flatMap((part) => ("text" in part ? [part.text] : [])),
	);
}

const erroredAssistant = {
	role: "assistant",
	content: [],
	stopReason: "error",
	errorMessage: "Model error: 400",
};
const thinkingOnlyAssistant = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "planning..." }],
	stopReason: "stop",
};

console.log("Bedrock: history with an errored assistant turn (content: [])");
{
	const payload = piContextToBedrockConverse({
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "hello" },
			erroredAssistant,
			{ role: "user", content: "hello again" },
		],
	});
	check(
		bedrockTextBlocks(payload).every((text) => text.trim().length > 0),
		"no empty/whitespace-only text blocks",
	);
	check(
		payload.messages.length === 1 && payload.messages[0].role === "user",
		"dropped turn's neighbours coalesce into one user message",
	);
	check(
		payload.messages[0].content.length === 2,
		"both user texts survive the coalesce",
	);
}

console.log("Bedrock: thinking-only assistant turn is dropped");
{
	const payload = piContextToBedrockConverse({
		messages: [
			{ role: "user", content: "hello" },
			thinkingOnlyAssistant,
			{ role: "user", content: "again" },
		],
	});
	check(
		payload.messages.every((message) =>
			message.content.every(
				(block) => !("text" in block) || block.text.trim().length > 0,
			),
		),
		"no whitespace placeholder emitted",
	);
}

console.log("Bedrock: empty user text parts are filtered, images survive");
{
	const payload = piContextToBedrockConverse({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "image", mimeType: "image/png", data: "aGk=" },
				],
			},
		],
	});
	check(payload.messages.length === 1, "image-only user message survives");
	check(
		payload.messages[0].content.every((block) => !("text" in block)),
		"empty text part removed",
	);
}

console.log("Bedrock: whitespace-only turns leave a valid degenerate payload");
{
	const payload = piContextToBedrockConverse({
		messages: [{ role: "user", content: "   " }, erroredAssistant],
	});
	check(payload.messages.length === 1, "one fallback message");
	check(
		payload.messages[0].content[0].text.trim().length > 0,
		"fallback text is non-whitespace",
	);
}

console.log("Bedrock: empty tool-result text gets a non-whitespace fallback");
{
	const payload = piContextToBedrockConverse({
		messages: [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_1", name: "tool", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: "call_1", content: [], isError: false },
		],
	});
	check(
		bedrockTextBlocks(payload).every((text) => text.trim().length > 0),
		"tool_result content text is non-whitespace",
	);
}

console.log("Bedrock: a plain conversation is unchanged");
{
	const payload = piContextToBedrockConverse({
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
				stopReason: "stop",
			},
			{ role: "user", content: "how are you?" },
		],
	});
	check(payload.messages.length === 3, "three messages, none dropped");
	check(
		payload.messages.map((message) => message.role).join(",") ===
			"user,assistant,user",
		"role alternation preserved",
	);
}

console.log("Vertex: mirrors the drop behaviour");
{
	const payload = piContextToVertexGenerateContent({
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "hello" },
			erroredAssistant,
			{ role: "user", content: "hello again" },
		],
	});
	check(
		vertexTextParts(payload).every((text) => text.trim().length > 0),
		"no empty/whitespace-only text parts",
	);
	check(
		payload.contents.length === 1 && payload.contents[0].role === "user",
		"dropped turn's neighbours coalesce into one user content",
	);
}

console.log("Vertex: whitespace-only turns leave a valid degenerate payload");
{
	const payload = piContextToVertexGenerateContent({
		messages: [{ role: "user", content: "   " }],
	});
	check(payload.contents.length === 1, "one fallback content entry");
	check(
		payload.contents[0].parts[0].text.trim().length > 0,
		"fallback text is non-whitespace",
	);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll checks passed");
