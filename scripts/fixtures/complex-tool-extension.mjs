// Test-only pi extension: registers a `record_choice` tool whose parameter
// schema contains the exact JSON Schema constructs that Gemini's legacy
// OpenAPI `parameters` field rejects (`const`, boolean `enum`, nested anyOf).
//
// Loaded by scripts/validate-foundation-executables.mjs to exercise the real
// HTTP tool-schema path end-to-end. If an adapter serializes tool schemas
// incorrectly, the provider returns HTTP 400 and the live scenario fails.
//
// The tool simply writes its stringified args to OUTPUT_FILE so the validator
// can assert a real side effect (proving the model both received the schema
// and successfully issued a tool call against it).

import { writeFileSync } from "node:fs";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function (pi) {
	pi.registerTool({
		name: "record_choice",
		label: "Record Choice",
		description:
			"Record a processing choice. Call this once with mode set to 'fast'.",
		promptSnippet: "record_choice: record a processing choice",
		// Raw JSON Schema (cast through unknown) with the constructs that broke
		// Gemini's legacy `parameters` field. TypeBox typing is bypassed on
		// purpose — we are validating wire serialization, not TS ergonomics.
		parameters: /** @type {any} */ ({
			type: "object",
			properties: {
				mode: {
					anyOf: [{ const: "fast" }, { const: "slow" }],
					description: "Processing mode",
				},
				verbose: {
					anyOf: [{ type: "boolean" }, { enum: [false] }],
					description: "Verbose flag",
				},
				steps: {
					type: "array",
					items: {
						type: "object",
						properties: {
							kind: { anyOf: [{ const: "read" }, { const: "write" }] },
						},
					},
				},
			},
			required: ["mode"],
		}),
		async execute(_toolCallId, params) {
			const outputFile = process.env.COMPLEX_TOOL_OUTPUT_FILE;
			if (outputFile) {
				writeFileSync(outputFile, JSON.stringify(params ?? {}));
			}
			return {
				content: [{ type: "text", text: "COMPLEX_TOOL_OK" }],
			};
		},
	});
}
