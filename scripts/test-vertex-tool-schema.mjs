#!/usr/bin/env node
// Offline regression test for the Vertex/Gemini tool-schema translation.
//
// The live validator (validate-foundation-executables.mjs) only ever sent the
// trivial `bash` tool, whose schema is a flat object with one string property.
// That never exercised the JSON Schema constructs Gemini's legacy `parameters`
// (OpenAPI 3.0 subset) rejects — `const` and non-string `enum` values — so a
// real 400 in production slipped past a "green" validation run.
//
// This test asserts the translator emits `parametersJsonSchema` (full JSON
// Schema) rather than the legacy `parameters` field, and that the failing
// constructs survive the translation intact. It makes NO network calls.
//
// Usage from repo root:
//   node scripts/test-vertex-tool-schema.mjs

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

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

// A schema that reproduces every class from the reported production 400:
//   - `const` keyword                        → "Unknown name const"
//   - boolean `enum` value (`false`)         → "enum[0] (TYPE_STRING), false"
//   - nested anyOf/items                     → deep property paths in the error
const context = {
	systemPrompt: "system",
	messages: [{ role: "user", content: "hi" }],
	tools: [
		{
			name: "complex_tool",
			description: "reproduces the reported Gemini 400 schema classes",
			parameters: {
				type: "object",
				properties: {
					mode: { anyOf: [{ const: "fast" }, { const: "slow" }] },
					flag: { anyOf: [{ type: "boolean" }, { enum: [false] }] },
					items: {
						type: "array",
						items: {
							type: "object",
							properties: {
								kind: { anyOf: [{ const: "a" }, { const: "b" }] },
							},
						},
					},
				},
				required: ["mode"],
			},
		},
	],
};

const out = piContextToVertexGenerateContent(context);
const fd = out.tools?.[0]?.functionDeclarations?.[0];

check(!!fd, "tool is translated to a functionDeclaration");
check(
	fd && Object.hasOwn(fd, "parametersJsonSchema"),
	"emits `parametersJsonSchema` (full JSON Schema field Gemini accepts)",
);
check(
	fd && !Object.hasOwn(fd, "parameters"),
	"does NOT emit legacy `parameters` (OpenAPI subset that 400s on const/enum)",
);

const serialized = JSON.stringify(fd?.parametersJsonSchema ?? {});
check(
	serialized.includes('"const"'),
	"`const` keyword survives translation (not stripped/rewritten)",
);
check(
	serialized.includes("false"),
	"boolean `enum` value survives translation",
);

if (failures > 0) {
	console.error(`\n❌ vertex tool-schema test: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ vertex tool-schema translation test passed");
