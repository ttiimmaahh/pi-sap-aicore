#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { streamSapAiCore } from "../src/stream.ts";

const requests = [];
const server = createServer(async (request, response) => {
	if (request.url === "/oauth/token") {
		response.setHeader("Content-Type", "application/json");
		const token = [
			Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
			Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
			"probe",
		].join(".");
		response.end(JSON.stringify({ access_token: token, expires_in: 3600 }));
		return;
	}
	if (request.url?.startsWith("/v2/lm/deployments")) {
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({
			resources: [{ id: "probe", deploymentUrl: `${origin}/deployment`, status: "RUNNING" }],
		}));
		return;
	}
	if (request.method === "POST" && request.url === "/v2/inference/deployments/probe/v2/completion") {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(JSON.parse(body));
		response.setHeader("Content-Type", "text/event-stream");
		response.end(`data: ${JSON.stringify({
			request_id: "probe",
			final_result: {
				choices: [{ index: 0, delta: { content: "PROBE_OK" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			},
		})}\n\ndata: [DONE]\n\n`);
		return;
	}
	response.writeHead(404).end();
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const apiKey = JSON.stringify({
	clientid: "probe-client",
	clientsecret: "probe-secret",
	url: origin,
	serviceurls: { AI_API_URL: origin },
});
const model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "sap-aicore-orchestration",
	provider: "sap-aicore",
	baseUrl: origin,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1050000,
	maxTokens: 128000,
	thinkingLevelMap: { high: "high", xhigh: "xhigh" },
};
const context = {
	messages: [{ role: "user", content: "Report the result.", timestamp: 1 }],
	tools: [{
		name: "report_probe",
		description: "Report an arithmetic result",
		parameters: {
			type: "object",
			properties: { value: { type: "integer" } },
			required: ["value"],
		},
	}],
};

try {
	for (const reasoning of ["high", "xhigh", "off"]) {
		const result = await streamSapAiCore(model, context, { apiKey, reasoning }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const request = requests.at(-1);
		assert.equal(request.config.modules.prompt_templating.prompt.tools[0].function.name, "report_probe");
		assert.equal(
			request.config.modules.prompt_templating.model.params.reasoning_effort,
			reasoning === "off" ? undefined : reasoning,
		);
	}
	console.log("Orchestration sends configured reasoning effort together with tools");
} finally {
	server.closeAllConnections();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
