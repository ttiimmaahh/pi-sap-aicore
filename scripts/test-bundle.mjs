#!/usr/bin/env node
// Sends a real prompt through pi and the built bundle to a local mock of SAP AI
// Core, on every SAP route, on both runtimes pi ships on.
//
// A load check is not enough here. A bundle can load cleanly and still fail on
// its first request, so each case has to get a model reply back through the SDK.
//
// The packed tarball is installed the way pi installs it, so only what a user
// gets is on disk. Each case gets its own TMPDIR, and with it an empty jiti
// cache: some failures only happen on an uncached load, when pi has Babel loaded.
//
// Runtimes:
//   Node  this repo's pi devDependency, run by the current node
//   Bun   the standalone binary from PI_STANDALONE_BIN, else mise's install.
//         Skipped locally when absent; required when CI is set.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TIMEOUT_MS = 60_000;

const reply = (route) => `BUNDLE-OK-${route}`;

const ROUTES = [
	{ route: "orchestration", provider: "sap-aicore", model: "anthropic--claude-4.8-opus", path: /\/v2\/completion$/ },
	{ route: "azure-openai", provider: "sap-aicore-foundation", model: "gpt-5.5", path: /\/chat\/completions/ },
	{ route: "aws-bedrock", provider: "sap-aicore-foundation", model: "anthropic--claude-4.8-opus", path: /\/converse$/ },
	{ route: "gcp-vertexai", provider: "sap-aicore-foundation", model: "gemini-3.5-flash", path: /:generateContent$/ },
];

let failures = 0;
function check(condition, message) {
	console.log(`  ${condition ? "✓" : "❌"} ${message}`);
	if (!condition) failures++;
}

function runtimes() {
	const node = { name: "Node", bin: join(ROOT, "node_modules/.bin/pi") };
	const standalone =
		process.env.PI_STANDALONE_BIN ??
		join(homedir(), ".local/share/mise/installs/pi/latest/pi/pi");
	if (existsSync(standalone)) return [node, { name: "Bun", bin: standalone }];

	if (process.env.CI) {
		console.error(`❌ standalone pi not found at ${standalone}; set PI_STANDALONE_BIN`);
		process.exit(1);
	}
	console.log("– Bun skipped: no standalone pi found (set PI_STANDALONE_BIN)\n");
	return [node];
}

function deployment(baseUrl, id, scenarioId, executableId, modelName) {
	return {
		id,
		deploymentUrl: `${baseUrl}/v2/inference/deployments/${id}`,
		configurationId: "config",
		configurationName: "config",
		executableId,
		scenarioId,
		status: "RUNNING",
		targetStatus: "RUNNING",
		createdAt: "2026-01-01T00:00:00Z",
		modifiedAt: "2026-01-01T00:00:00Z",
		details: {
			resources: { backendDetails: { model: { name: modelName, version: "latest" } } },
			scaling: { backendDetails: {} },
		},
	};
}

function deployments(baseUrl) {
	return [
		deployment(baseUrl, "orchestration", "orchestration", "orchestration", "orchestration"),
		...ROUTES.filter((r) => r.provider === "sap-aicore-foundation").map((r) =>
			deployment(baseUrl, r.route, "foundation-models", r.route, r.model),
		),
	];
}

function startMock() {
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const url = new URL(req.url, "http://mock");
			requests.push(url.pathname);
			const json = (body) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			const sse = (chunks) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`);
			};
			const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
			const chunk = (delta, finish_reason, extra) => ({
				id: "chunk",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock",
				choices: [{ index: 0, delta, finish_reason }],
				...extra,
			});

			if (url.pathname.endsWith("/oauth/token")) {
				const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
				const claims = { exp: Math.floor(Date.now() / 1000) + 3600, zid: "tenant" };
				return json({
					access_token: `${encode({ alg: "none" })}.${encode(claims)}.signature`,
					token_type: "bearer",
					expires_in: 3600,
				});
			}
			if (url.pathname === "/v2/lm/deployments") {
				const scenario = url.searchParams.get("scenarioId");
				const executable = url.searchParams.get("executableIds");
				const resources = deployments(`http://${req.headers.host}`).filter(
					(d) => d.scenarioId === scenario && (!executable || d.executableId === executable),
				);
				return json({ count: resources.length, resources });
			}

			const route = ROUTES.find((r) => r.path.test(url.pathname));
			switch (route?.route) {
				case "orchestration":
					return sse([
						{ request_id: "r", final_result: chunk({ role: "assistant", content: reply(route.route) }, null) },
						{ request_id: "r", final_result: chunk({ content: "" }, "stop", { usage }) },
					]);
				case "azure-openai":
					return sse([
						chunk({ role: "assistant", content: reply(route.route) }, null),
						chunk({}, "stop", { usage }),
					]);
				case "aws-bedrock":
					return json({
						output: { message: { role: "assistant", content: [{ text: reply(route.route) }] } },
						stopReason: "end_turn",
						usage: { inputTokens: 1, outputTokens: 1 },
					});
				case "gcp-vertexai":
					return json({
						candidates: [{ content: { role: "model", parts: [{ text: reply(route.route) }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
					});
				default:
					res.writeHead(404, { "content-type": "application/json" });
					res.end("{}");
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
	});
}

// Asynchronous on purpose: the mock shares this process's event loop.
function runPi(bin, args, env, cwd) {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d) => (output += d));
		child.stderr.on("data", (d) => (output += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ status: null, output: String(error) });
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, output });
		});
	});
}

if (!existsSync(join(ROOT, "dist/index.js"))) {
	console.error("❌ dist/index.js not found; run npm run build");
	process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "pi-sap-bundle-"));
const installDir = join(temp, "install");
const agentDir = join(temp, "agent");
mkdirSync(installDir);
const npm = (...args) => execFileSync("npm", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const tarball = npm("pack", "--ignore-scripts", "--silent", "--pack-destination", temp).trim().split("\n").pop();
npm(
	"install", "--prefix", installDir, join(temp, tarball),
	"--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--silent",
);
const extension = join(installDir, "node_modules/pi-sap-aicore/dist/index.js");
mkdirSync(join(agentDir, "pi-sap-aicore"), { recursive: true });
writeFileSync(
	join(agentDir, "pi-sap-aicore/models.json"),
	JSON.stringify({
		foundation: {
			enabledModelIds: ROUTES.filter((r) => r.provider === "sap-aicore-foundation").map((r) => r.model),
		},
	}),
);

const { server, requests, port } = await startMock();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	AICORE_SERVICE_KEY: JSON.stringify({
		clientid: "client",
		clientsecret: "secret",
		url: baseUrl,
		identityzone: "tenant",
		identityzoneid: "tenant",
		appname: "app",
		serviceurls: { AI_API_URL: baseUrl },
	}),
};
delete env.AICORE_RESOURCE_GROUP;

try {
	for (const runtime of runtimes()) {
		console.log(`${runtime.name} (${runtime.bin})`);
		for (const { route, provider, model, path } of ROUTES) {
			requests.length = 0;
			const caseTemp = mkdtempSync(join(temp, "case-"));
			const { status, output } = await runPi(
				runtime.bin,
				[
					"-ne", "-e", extension,
					"--no-session", "--no-tools", "--offline",
					"--provider", provider, "--model", model, "-p", "ping",
				],
				{ ...env, TMPDIR: caseTemp },
				temp,
			);
			rmSync(caseTemp, { recursive: true, force: true });
			const ok = status === 0 && output.includes(reply(route)) && requests.some((p) => path.test(p));
			check(ok, ok ? route : `${route}: exit ${status}\n      ${output.trim().slice(0, 500)}`);
		}
		console.log("");
	}
} finally {
	server.close();
	rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("The bundle serves every SAP route on each runtime tested");
