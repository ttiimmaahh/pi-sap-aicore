#!/usr/bin/env node
// Offline regression test for reasoning_effort on orchestration tool turns.
//
// SAP accepts the pair for some models and refuses it for others, so the adapter
// sends the effort, and on that specific refusal retries once without it. Runs the
// real SAP SDK against a local mock, using the error frame SAP really returned.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { streamSapAiCore } from "../src/stream.ts";

const REFUSAL =
	"400 - LLM Module: Function tools with reasoning_effort are not supported for this " +
	"model in /v1/chat/completions. To use function tools, use /v1/responses or set " +
	"reasoning_effort to 'none'.";
const sapError = (message) => ({ code: 400, message, location: "LLM Module", request_id: "mock" });

const textFrame = (content, finish_reason) => ({
	request_id: "mock",
	final_result: {
		id: "mock",
		object: "chat.completion.chunk",
		created: 1,
		model: "mock",
		choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }],
		...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
	},
});

const received = [];
const sse = (response, frames) => {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`);
};

function respondToCompletion(response, body) {
	const { model, prompt } = body.config.modules.prompt_templating;
	const hasEffort = model.params.reasoning_effort !== undefined;
	const refuses = hasEffort && Boolean(prompt.tools?.length);
	received.push({ model: model.name, effort: model.params.reasoning_effort, tools: prompt.tools?.length ?? 0 });

	if (model.name === "gpt-unrelated-400") {
		return sse(response, [{ error: sapError("400 - LLM Module: Unsupported parameter") }]);
	}
	if (model.name === "gpt-refuses-mid-output" && refuses) {
		return sse(response, [textFrame("partial", null), { error: sapError(REFUSAL) }]);
	}
	if (model.name === "gpt-refuses-http" && refuses) {
		response.writeHead(400, { "content-type": "application/json" });
		return response.end(JSON.stringify({ error: sapError(REFUSAL) }));
	}
	if (model.name.startsWith("gpt-refuses") && refuses) {
		return sse(response, [{ error: sapError(REFUSAL) }]);
	}
	return sse(response, [textFrame("OK", null), textFrame("", "stop")]);
}

const server = createServer((request, response) => {
	let raw = "";
	request.on("data", (chunk) => (raw += chunk));
	request.on("end", () => {
		const json = (body) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (request.url.endsWith("/oauth/token")) {
			const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
			const claims = { exp: Math.floor(Date.now() / 1000) + 3600, zid: "tenant" };
			return json({ access_token: `${encode({ alg: "none" })}.${encode(claims)}.sig`, expires_in: 3600 });
		}
		if (request.url.startsWith("/v2/lm/deployments")) {
			return json({
				count: 1,
				resources: [{
					id: "mock",
					deploymentUrl: `${origin}/v2/inference/deployments/mock`,
					scenarioId: "orchestration",
					status: "RUNNING",
				}],
			});
		}
		if (request.url.endsWith("/completion")) return respondToCompletion(response, JSON.parse(raw));
		response.writeHead(404).end("{}");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const apiKey = JSON.stringify({
	clientid: "client",
	clientsecret: "secret",
	url: origin,
	identityzone: "tenant",
	identityzoneid: "tenant",
	appname: "app",
	serviceurls: { AI_API_URL: origin },
});
const modelNamed = (id) => ({
	id,
	name: id,
	api: "sap-aicore-orchestration",
	provider: "sap-aicore",
	baseUrl: origin,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
	thinkingLevelMap: { low: "low", high: "high" },
});
const prompt = { role: "user", content: "hello", timestamp: 1 };
const tool = {
	name: "lookup",
	description: "Look something up",
	parameters: { type: "object", properties: { q: { type: "string" } } },
};
const toolContext = { messages: [prompt], tools: [tool] };
const textContext = { messages: [prompt] };

async function run(id, context, reasoning = "high") {
	received.length = 0;
	const stream = streamSapAiCore(modelNamed(id), context, { apiKey, reasoning });
	const events = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	return { result, events, requests: [...received] };
}

const failures = [];
async function test(name, body) {
	try {
		await body();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  ❌ ${name}: ${error.message}`);
	}
}

try {
	await test("an accepting model keeps the effort on tool turns", async () => {
		const { result, requests } = await run("gpt-accepts", toolContext);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests, [{ model: "gpt-accepts", effort: "high", tools: 1 }]);
	});

	await test("thinking off sends no effort", async () => {
		const { requests } = await run("gpt-accepts", toolContext, "off");
		assert.deepEqual(requests, [{ model: "gpt-accepts", effort: undefined, tools: 1 }]);
	});

	await test("a mid-stream refusal retries once without the effort", async () => {
		const { result, events, requests } = await run("gpt-refuses-sse", toolContext);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests.map((r) => r.effort), ["high", undefined]);
		assert.equal(events.filter((e) => e === "start").length, 1);
		assert.equal(events.includes("error"), false);
		assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
	});

	await test("a refused model skips the effort on later tool turns", async () => {
		const { result, requests } = await run("gpt-refuses-sse", toolContext);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests.map((r) => r.effort), [undefined]);
	});

	await test("a refused model keeps the effort on text-only turns", async () => {
		const { requests } = await run("gpt-refuses-sse", textContext);
		assert.deepEqual(requests.map((r) => r.effort), ["high"]);
	});

	await test("an HTTP 400 refusal also retries", async () => {
		const { result, requests } = await run("gpt-refuses-http", toolContext);
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests.map((r) => r.effort), ["high", undefined]);
	});

	await test("other SAP errors are not retried", async () => {
		const { result, requests } = await run("gpt-unrelated-400", toolContext);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /Unsupported parameter/);
		assert.equal(requests.length, 1);
	});

	await test("a refusal after output has started is not retried", async () => {
		const { result, requests } = await run("gpt-refuses-mid-output", toolContext);
		assert.equal(result.stopReason, "error");
		assert.equal(requests.length, 1);
	});
} finally {
	server.closeAllConnections();
	server.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nTool-turn reasoning effort falls back only on SAP's refusal");
