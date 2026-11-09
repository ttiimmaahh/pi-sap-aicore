#!/usr/bin/env node
// Two guards around src/transform-messages.ts, the vendored copy of pi's
// `@earendil-works/pi-ai/api/transform-messages`.
//
// 1. No extension source may import a pi package for a *value* unless pi's
//    extension loader maps that exact specifier. The map in pi's
//    `core/extensions/loader.js` is the only contract that holds across builds:
//    an npm-layout pi still has its dependencies on disk, so jiti falls through
//    to Node resolution and an unmapped specifier resolves by luck, while a
//    bundled pi has nothing to fall through to and dies at load time. 0.4.3
//    shipped exactly that way — green on the maintainer's pi, broken on a
//    bundled one:
//      Failed to load extension: Cannot find module
//      '@earendil-works/pi-ai/api/transform-messages'
//    Booting pi cannot be the guard here, because whether it catches the bug
//    depends on which pi build runs the test. Checking the specifier against the
//    map is build-independent, so that is what this does. Type-only imports are
//    erased before any resolver sees them and are always safe, at any subpath.
//
// 2. The vendored function must still behave like pi's. Where pi-ai *is*
//    resolvable (this repo's dev install) every fixture below is run through
//    both implementations and the outputs compared, so drift shows up in
//    `npm test` rather than in a user's session.
//
// This test makes no network calls.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const load = (file) => import(pathToFileURL(join(ROOT, file)).href);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

// ---------------------------------------------------------------------------
// 1. Static scan: every pi-ai import must be type-only.
// ---------------------------------------------------------------------------

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			yield* walk(path);
		} else if (entry.endsWith(".ts")) {
			yield path;
		}
	}
}

// Comments carry the word "import" and these package names (this file's header
// included), so strip block comments and whole-line `//` comments first. Partial
// stripping keeps string literals such as "https://..." intact.
const stripComments = (text) =>
	text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

// Mirrors VIRTUAL_MODULES / getAliases() in pi's core/extensions/loader.js.
// The legacy @mariozechner/* spellings are aliased too but deliberately omitted:
// nothing here should be reaching for them.
const ALIASED = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
]);

// An import statement ends at its `;`, so `[^;]*?` cannot run past one — that
// bounds a match to a single statement even in the multi-line brace form.
const TYPE_ONLY = /\bimport\s+type\b[^;]*?["']@earendil-works\/[^"']*["']/g;
const ANY_REFERENCE = /["'](@earendil-works\/[^"']*)["']/g;

console.log("pi imports resolve through pi's extension-loader alias map");
const sources = [join(ROOT, "index.ts"), ...walk(join(ROOT, "src"))];
for (const file of sources) {
	const code = stripComments(readFileSync(file, "utf8"));
	const relative = file.slice(ROOT.length);
	// Blanking the type-only statements leaves exactly the value imports behind.
	const valueImports = [
		...code.replace(TYPE_ONLY, "").matchAll(ANY_REFERENCE),
	].map((match) => match[1]);
	if (valueImports.length === 0) continue;
	const offenders = valueImports.filter((spec) => !ALIASED.has(spec));
	check(
		offenders.length === 0,
		offenders.length === 0
			? `${relative}: value import(s) of ${[...new Set(valueImports)].join(", ")} are aliased`
			: `${relative}: ${[...new Set(offenders)].join(", ")} is not in pi's alias map — vendor it or use type-only import`,
	);
}

// ---------------------------------------------------------------------------
// 2. Behaviour: fixtures through the vendored copy, diffed against pi's.
// ---------------------------------------------------------------------------

const { transformMessages } = await load("src/transform-messages.ts");

const MODEL = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "sap-aicore-orchestration",
	provider: "sap-aicore",
	baseUrl: "https://example.invalid",
	reasoning: "none",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const VISION_MODEL = { ...MODEL, input: ["text", "image"] };
const OTHER_MODEL = { ...MODEL, id: "claude-sonnet-4", provider: "anthropic" };

const assistant = (content, overrides = {}) => ({
	role: "assistant",
	content,
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	...overrides,
});
const user = (content) => ({ role: "user", content, timestamp: 1 });
const toolCall = (id) => ({
	type: "toolCall",
	id,
	name: "read",
	arguments: {},
});
const toolResult = (id) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 1,
});
const IMAGE = { type: "image", data: "AAAA", mimeType: "image/png" };

const FIXTURES = [
	{
		name: "errored assistant turn with unanswered tool calls is dropped",
		model: MODEL,
		messages: [
			user("go"),
			assistant([toolCall("call_1")], { stopReason: "error" }),
			user("again"),
		],
		expect: (out) =>
			check(
				out.length === 2 && out.every((m) => m.role === "user"),
				"errored turn and its orphaned call both vanish",
			),
	},
	{
		name: "aborted assistant turn is dropped",
		model: MODEL,
		messages: [assistant([toolCall("call_1")], { stopReason: "aborted" })],
		expect: (out) => check(out.length === 0, "aborted turn leaves nothing"),
	},
	{
		name: "orphaned tool call interrupted by a user message gets a result",
		model: MODEL,
		messages: [assistant([toolCall("call_1")]), user("never mind")],
		expect: (out) =>
			check(
				out.length === 3 &&
					out[1].role === "toolResult" &&
					out[1].toolCallId === "call_1" &&
					out[1].isError === true,
				"synthetic error result is spliced in before the user turn",
			),
	},
	{
		name: "conversation ending on an unresolved tool call gets a result",
		model: MODEL,
		messages: [assistant([toolCall("call_1"), toolCall("call_2")]), toolResult("call_1")],
		expect: (out) =>
			check(
				out.length === 3 && out[2].toolCallId === "call_2" && out[2].isError,
				"only the unanswered id is synthesised",
			),
	},
	{
		name: "images are downgraded for a text-only model",
		model: MODEL,
		messages: [
			user([{ type: "text", text: "look" }, IMAGE, IMAGE]),
			{ ...toolResult("call_1"), content: [IMAGE] },
		],
		expect: (out) =>
			check(
				out[0].content.length === 2 &&
					out[0].content[1].text.includes("image omitted") &&
					out[1].content[0].text.includes("tool image omitted"),
				"consecutive images collapse to one placeholder each side",
			),
	},
	{
		name: "images survive on a vision model",
		model: VISION_MODEL,
		messages: [user([{ type: "text", text: "look" }, IMAGE])],
		expect: (out) =>
			check(out[0].content[1].type === "image", "image passes through"),
	},
	{
		name: "thinking blocks across a model switch",
		model: OTHER_MODEL,
		messages: [
			assistant([
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "x", redacted: true },
				{ type: "toolCall", id: "call_1", name: "read", arguments: {}, thoughtSignature: "ts" },
			]),
			toolResult("call_1"),
		],
		expect: (out) =>
			check(
				out[0].content.length === 1 &&
					out[0].content[0].type === "toolCall" &&
					out[0].content[0].thoughtSignature === undefined,
				"all thinking drops, thoughtSignature strips",
			),
	},
	{
		name: "same-model thinking is preserved verbatim",
		model: MODEL,
		messages: [
			assistant([
				{ type: "thinking", thinking: "", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "x", redacted: true },
			]),
		],
		expect: (out) =>
			check(
				out[0].content.length === 2 && out[0].content[0].thinkingSignature === "sig",
				"signed-but-empty and redacted blocks both stay",
			),
	},
	{
		name: "null content from untyped callers is normalised",
		model: MODEL,
		messages: [{ role: "user", content: null, timestamp: 1 }],
		expect: (out) =>
			check(Array.isArray(out[0].content) && out[0].content.length === 0, "content becomes []"),
	},
];

console.log("\nvendored transformMessages behaviour");
for (const fixture of FIXTURES) {
	console.log(` ${fixture.name}`);
	fixture.expect(transformMessages(structuredClone(fixture.messages), fixture.model));
}

// Synthetic tool results are stamped with Date.now(); blank it before diffing.
const stable = (messages) =>
	JSON.stringify(messages, (key, value) => (key === "timestamp" ? 0 : value));

console.log("\nparity with pi's own transformMessages");
let upstream;
try {
	({ transformMessages: upstream } = await import(
		"@earendil-works/pi-ai/api/transform-messages"
	));
} catch {
	// Expected wherever pi-ai is not installed alongside this package — which is
	// every real user install, and the whole reason the function is vendored.
	console.log("  – skipped: @earendil-works/pi-ai not resolvable here");
}
if (upstream) {
	for (const fixture of FIXTURES) {
		const mine = transformMessages(structuredClone(fixture.messages), fixture.model);
		const theirs = upstream(structuredClone(fixture.messages), fixture.model);
		check(stable(mine) === stable(theirs), `${fixture.name}: matches upstream`);
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll transform-messages checks passed");
