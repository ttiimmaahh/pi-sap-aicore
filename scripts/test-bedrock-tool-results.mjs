#!/usr/bin/env node
// Offline regression test for Bedrock/Anthropic tool_result ordering.
//
// Anthropic models behind Bedrock require the user message immediately after an
// assistant tool_use turn to begin with one tool_result block per tool_use id.
// Pi stores each tool result as a separate top-level message, and screenshot
// tool results can include images. A naive role coalesce produces:
//   assistant(tool_use a,b), user(tool_result a, image, tool_result b)
// which Anthropic rejects because tool_result b is not in the required prefix.
// This test makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { piContextToBedrockConverse } = await import(
	pathToFileURL(join(ROOT, "src/translate-foundation-bedrock.ts")).href
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

const context = {
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tooluse_a",
					name: "screenshot",
					arguments: {},
				},
				{ type: "toolCall", id: "tooluse_b", name: "bash", arguments: {} },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "tooluse_a",
			toolName: "screenshot",
			content: [
				{ type: "text", text: "screenshot captured" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tooluse_b",
			toolName: "bash",
			content: [{ type: "text", text: "command output" }],
			isError: false,
			timestamp: 3,
		},
	],
	tools: [],
};

const out = piContextToBedrockConverse(context);
const [assistant, user] = out.messages;

check(
	out.messages.length === 2,
	"assistant turn and batched user result turn are emitted",
);
check(
	assistant?.content?.map((block) => block.toolUse?.toolUseId).join(",") ===
		"tooluse_a,tooluse_b",
	"assistant contains both toolUse blocks in order",
);
check(user?.role === "user", "next message after assistant toolUse is user");

const kinds = user?.content?.map((block) => Object.keys(block)[0]) ?? [];
check(
	kinds.slice(0, 2).join(",") === "toolResult,toolResult",
	"all expected toolResult blocks are the first blocks in the immediate user message",
);
check(
	kinds[2] === "image",
	"image content is preserved after the required toolResult prefix",
);
check(
	user?.content?.[0]?.toolResult?.toolUseId === "tooluse_a" &&
		user?.content?.[1]?.toolResult?.toolUseId === "tooluse_b",
	"toolResult ids match the assistant toolUse ids in order",
);

if (failures > 0) {
	console.error(
		`\n❌ bedrock tool-result ordering test: ${failures} check(s) failed`,
	);
	process.exit(1);
}
console.log("\n✅ bedrock tool-result ordering test passed");
