#!/usr/bin/env node
// Live validation for SAP AI Core direct foundation executables.
//
// This script makes real, billed model calls through pi using the local extension.
// It validates the three high-value foundation executable families:
//   - azure-openai  → GPT/OpenAI models
//   - aws-bedrock   → Anthropic/Claude models
//   - gcp-vertexai  → Gemini models
//
// Usage from repo root:
//   node scripts/validate-foundation-executables.mjs
//
// Optional model overrides:
//   GPT_MODEL=gpt-5.5 \
//   BEDROCK_MODEL=anthropic--claude-4.8-opus \
//   VERTEX_MODEL=gemini-3.5-flash \
//   node scripts/validate-foundation-executables.mjs
//
// Optional: SKIP_IMAGE=1 to skip vision tests.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const PI = process.env.PI_BIN ?? "pi";
const SKIP_IMAGE = process.env.SKIP_IMAGE === "1";

const SCENARIOS = [
	{
		name: "azure-openai/gpt",
		model: process.env.GPT_MODEL ?? "gpt-5.5",
		marker: "GPT_TOOL_OK",
	},
	{
		name: "aws-bedrock/anthropic",
		model: process.env.BEDROCK_MODEL ?? "anthropic--claude-4.8-opus",
		marker: "BEDROCK_TOOL_OK",
	},
	{
		name: "gcp-vertexai/gemini",
		model: process.env.VERTEX_MODEL ?? "gemini-3.5-flash",
		marker: "VERTEX_TOOL_OK",
	},
];

const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
	"base64",
);

function runPi(args, options = {}) {
	const result = spawnSync(PI, args, {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		...options,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function baseArgs(model) {
	return [
		"--no-extensions",
		"-e",
		"./index.ts",
		"--model",
		`sap-aicore-foundation/${model}`,
		"--no-context-files",
		"--no-skills",
		"-p",
	];
}

function assert(condition, message, detail) {
	if (condition) return;
	console.error(`\n❌ ${message}`);
	if (detail) console.error(detail);
	process.exitCode = 1;
	throw new Error(message);
}

function truncate(s, max = 2000) {
	return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

function validateText(scenario) {
	const prompt = "Reply with exactly the single token: TEXT_OK";
	const result = runPi([...baseArgs(scenario.model), prompt]);
	assert(
		result.status === 0,
		`${scenario.name} text scenario exited ${result.status}`,
		truncate(result.combined),
	);
	assert(
		/TEXT_OK/.test(result.combined),
		`${scenario.name} text scenario did not contain TEXT_OK`,
		truncate(result.combined),
	);
	console.log(`  ✓ text generation`);
}

function validateToolUse(scenario, workDir) {
	const file = join(workDir, `${scenario.name.replaceAll("/", "-")}.txt`);
	const prompt =
		`Use the bash tool to run exactly: printf ${scenario.marker} > ${file}. ` +
		"Then say done.";
	const result = runPi([...baseArgs(scenario.model), prompt]);
	assert(
		result.status === 0,
		`${scenario.name} tool scenario exited ${result.status}`,
		truncate(result.combined),
	);
	let actual = "";
	try {
		actual = readFileSync(file, "utf8");
	} catch {
		// handled below
	}
	assert(
		actual === scenario.marker,
		`${scenario.name} tool scenario did not create expected side-effect`,
		`expected file ${file} to contain ${scenario.marker}\nmodel output:\n${truncate(result.combined)}`,
	);
	console.log(`  ✓ tool execution side effect`);
}

function validateImage(scenario, workDir) {
	const imagePath = join(workDir, "tiny.png");
	writeFileSync(imagePath, tinyPng);
	const prompt =
		"Look at @" +
		imagePath +
		" and reply with exactly IMAGE_OK if you can inspect the attached image.";
	const result = runPi([...baseArgs(scenario.model), prompt]);
	assert(
		result.status === 0,
		`${scenario.name} image scenario exited ${result.status}`,
		truncate(result.combined),
	);
	assert(
		/IMAGE_OK/.test(result.combined),
		`${scenario.name} image scenario did not contain IMAGE_OK`,
		truncate(result.combined),
	);
	console.log(`  ✓ image input smoke test`);
}

const workDir = mkdtempSync(join(tmpdir(), "pi-sap-aicore-foundation-"));
console.log(`Live SAP AI Core foundation validation`);
console.log(`repo: ${ROOT}`);
console.log(`workDir: ${workDir}`);
console.log(`skip image: ${SKIP_IMAGE ? "yes" : "no"}\n`);

try {
	for (const scenario of SCENARIOS) {
		console.log(`${scenario.name}  model=${scenario.model}`);
		validateText(scenario);
		validateToolUse(scenario, workDir);
		if (!SKIP_IMAGE) validateImage(scenario, workDir);
		console.log("");
	}
	console.log("✅ all foundation executable scenarios passed");
} catch {
	// assert() already printed details and set exitCode.
} finally {
	if (process.env.KEEP_VALIDATION_ARTIFACTS !== "1") {
		rmSync(workDir, { recursive: true, force: true });
	} else {
		console.log(`kept artifacts: ${workDir}`);
	}
}
