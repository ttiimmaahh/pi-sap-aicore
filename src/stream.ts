import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type {
	ChatModel,
	LlmModelParams,
} from "@sap-ai-sdk/orchestration";
import type { TokenUsage } from "@sap-ai-sdk/orchestration/internal.js";

import { parseAndValidateServiceKey, type ValidatedKey } from "./auth.ts";
import { mapFinishReason, piContextToOrchestration } from "./translate.ts";

// `@sap-ai-sdk/orchestration` is loaded dynamically (not at module load) so a
// missing dependency surfaces as an actionable, in-stream error instead of a
// raw `ERR_MODULE_NOT_FOUND` crash at pi startup. Only the `OrchestrationClient`
// value needs a runtime import — every other SAP symbol used here is `import
// type` and erased at compile time, so importing this module is side-effect
// free until the first actual stream. Keeping the import here (rather than an
// `async` wrapper in index.ts) lets `streamSimple` stay synchronous, which is
// the shape pi's provider contract requires.
async function importOrchestration(): Promise<
	typeof import("@sap-ai-sdk/orchestration")
> {
	try {
		return await import("@sap-ai-sdk/orchestration");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		const msg = (err as Error)?.message ?? "";
		const isMissingSapSdk =
			code === "ERR_MODULE_NOT_FOUND" &&
			msg.includes("@sap-ai-sdk/orchestration");
		if (!isMissingSapSdk) throw err;

		throw new Error(
			"The SAP AI Core SDK (@sap-ai-sdk/orchestration) isn't installed, so " +
				"this provider can't make requests. pi loaded the extension but its " +
				"dependencies didn't finish installing. Fix: run `npm install` in the " +
				"pi-sap-aicore directory (where pi installed it, e.g. under " +
				"~/.pi/agent/), then restart pi. See the pi-sap-aicore README " +
				"(Installation) for details.",
		);
	}
}

// Opt-in request logging for diagnosing server-side failures whose error body
// doesn't echo back what we sent (e.g. SAP's "Internal server error" 500s,
// which only return the templating result, not the params/messages). Set
// PI_SAP_AICORE_DEBUG_PAYLOAD to a file path to append one JSON line per
// request and one per error — both keyed by the same `requestId`, so you can
// grep `"kind":"error"` and look up the request that triggered it. Set it to
// "1"/"true" to use <tmpdir>/pi-sap-aicore-payloads.jsonl. WARNING: logs full
// message bodies, so leave it off unless actively debugging — the file will
// contain prompt content.
function debugPayloadPath(): string | undefined {
	const v = process.env.PI_SAP_AICORE_DEBUG_PAYLOAD?.trim();
	if (!v) return undefined;
	if (v === "1" || v.toLowerCase() === "true") {
		return join(tmpdir(), "pi-sap-aicore-payloads.jsonl");
	}
	return v;
}

function debugLog(entry: Record<string, unknown>): void {
	const path = debugPayloadPath();
	if (!path) return;
	try {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(path, `${line}\n`);
	} catch {
		// Never let diagnostic logging break a real request.
	}
}

// SAP SDK wraps server-side errors as `Error while iterating over SSE stream`
// with the real error attached via `.cause`. Walk the chain so the user sees
// what SAP/Anthropic actually complained about.
//
// SAP's http-client.js wraps axios errors as
// `ErrorWithCause("Request failed with status code N.", axiosError)`. The
// wrapper .message and the axios .message are IDENTICAL, and the real
// server explanation lives on `axiosError.response.data` (already parsed
// from the SSE error frame by handleStreamError). Without extracting it,
// the surface is just "400 → 400" with no actionable info.
const MAX_DETAIL_CHARS = 2000;

function truncate(s: string, max = MAX_DETAIL_CHARS): string {
	return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

// Try known server-error shapes first (SAP, Anthropic-via-orchestration),
// fall back to JSON. Returns undefined when there's nothing meaningful to
// say beyond what .message already conveyed.
function extractServerDetail(data: unknown): string | undefined {
	if (data == null) return undefined;
	if (typeof data === "string") {
		const trimmed = data.trim();
		return trimmed.length > 0 ? truncate(trimmed) : undefined;
	}
	if (typeof data !== "object") return truncate(String(data));

	const d = data as Record<string, unknown>;

	// Anthropic-bubbled: { error: { type, message } } or { type, message }
	const nested = (d.error ?? d) as Record<string, unknown>;
	const nestedMsg =
		typeof nested.message === "string" ? nested.message : undefined;
	const nestedType = typeof nested.type === "string" ? nested.type : undefined;
	if (nestedMsg) {
		const loc =
			typeof nested.location === "string" ? nested.location : undefined;
		const prefix = nestedType ? `${nestedType}: ` : "";
		const suffix = loc ? ` (at ${loc})` : "";
		return truncate(`${prefix}${nestedMsg}${suffix}`);
	}

	// Fallback: stringify and let the user read it.
	try {
		return truncate(JSON.stringify(d));
	} catch {
		return truncate(String(d));
	}
}

// SAP SDK upstream bug: @sap-ai-sdk/core's `handleStreamError` (in
// http-client.js) does an unconditional `JSON.parse` on the response
// body via `node:stream/consumers`'s `json()`. When SAP AI Core's
// gateway (Envoy/Istio) returns a plain-text error like
//   `upstream connect error and disconnect/reset before headers...`
// — typical for transient backend unreachability, gateway timeouts,
// or some rate-limit responses — `JSON.parse` throws a raw V8
// SyntaxError that escapes BEFORE the SDK's `throw new ErrorWithCause`
// wrapper, so we lose the status code and any structured context.
//
// Detect that exact shape so the user sees something actionable
// instead of `Unexpected token 'u', "upstream c"... is not valid JSON`.
// We also try to recover the original gateway body text from the
// SyntaxError message itself (V8 includes the first ~chars of the
// offending input as `"upstream c"...`), so the user can tell
// envoy-from-anything-else apart at a glance.
function looksLikeSapGatewayJsonParseFailure(error: unknown): boolean {
	if (!(error instanceof SyntaxError)) return false;
	const msg = error.message ?? "";
	// V8 shape: `Unexpected token 'X', "<snippet>"... is not valid JSON`
	// or `Unexpected non-whitespace character...` for some payloads.
	return /is not valid JSON/.test(msg) || /Unexpected token/.test(msg);
}

function sapGatewayHint(error: SyntaxError): string {
	const snippetMatch = error.message.match(/"([^"]+)"\.\.\./);
	const snippet = snippetMatch?.[1];
	const body = snippet ? ` Body started with: "${snippet}...".` : "";
	const looksLikeEnvoy = snippet !== undefined && /^upstream\b/i.test(snippet);
	const diagnosis = looksLikeEnvoy
		? "SAP AI Core's gateway (Envoy) returned a plain-text error instead of JSON. " +
			"This is almost always transient — upstream connect failure, gateway " +
			"timeout on a long reasoning turn, or a non-JSON 429/503 from the proxy."
		: "SAP AI Core returned a non-JSON response body. Likely a transient " +
			"gateway/proxy error (timeout, upstream unreachable, or non-JSON 5xx).";
	return (
		`${diagnosis}${body} Retry usually works; if it persists, check the SAP AI ` +
		`Core service status and that your deployment + resource group are healthy. ` +
		`(Underlying SDK bug: @sap-ai-sdk/core's handleStreamError JSON.parses the ` +
		`error body unconditionally; see axios#6468.)`
	);
}

// SAP's SSE iterator (@sap-ai-sdk/core/dist/stream/sse-stream.js) throws
// `new Error("Error received from the server.\n" + JSON.stringify(data.error))`
// when the orchestration server emits a mid-stream error frame (e.g. a
// 500 from the LLM Module after templating succeeded). The JSON body
// includes `intermediate_results.templating`, which echoes our entire
// system prompt back at the user — useless noise that drowns the
// actionable bits ({code, message, location, request_id}). Detect this
// shape, extract the signal, and drop the echo.
function looksLikeSapServerSseError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("Error received from the server.")
	);
}

type SapSseErrorBody = {
	code?: number;
	message?: string;
	location?: string;
	request_id?: string;
};

function extractSapSseErrorDetail(error: Error): string | undefined {
	const newline = error.message.indexOf("\n");
	if (newline < 0) return undefined;
	const body = error.message.slice(newline + 1).trim();
	try {
		const d = JSON.parse(body) as SapSseErrorBody;
		const parts: string[] = [];
		if (typeof d.code === "number") parts.push(`SAP ${d.code}`);
		if (typeof d.location === "string" && d.location.length > 0)
			parts.push(`at ${d.location}`);
		const head = parts.length > 0 ? `${parts.join(" ")}: ` : "";
		const tail =
			typeof d.request_id === "string" && d.request_id.length > 0
				? ` (request_id: ${d.request_id})`
				: "";
		const msg = typeof d.message === "string" ? d.message : "(no message)";
		return `${head}${msg}${tail}`;
	} catch {
		return undefined;
	}
}

function formatError(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<string>();
	const push = (s: string | undefined) => {
		if (!s) return;
		if (seen.has(s)) return;
		seen.add(s);
		parts.push(s);
	};

	let current: unknown = error;
	while (current instanceof Error) {
		if (looksLikeSapServerSseError(current)) {
			const detail = extractSapSseErrorDetail(current);
			if (detail) {
				push(detail);
			} else {
				// Fallback: keep first line only so we don't dump the
				// echoed system prompt on a parse failure.
				push(current.message.split("\n", 1)[0]);
			}
		} else if (looksLikeSapGatewayJsonParseFailure(current)) {
			push(sapGatewayHint(current as SyntaxError));
			push(current.message);
		} else {
			push(current.message);
		}
		const response = (current as Error & { response?: { data?: unknown } })
			.response;
		push(extractServerDetail(response?.data));
		current = (current as Error & { cause?: unknown }).cause;
	}
	if (current !== undefined && current !== null) push(String(current));
	return parts.length > 0 ? parts.join(" → ") : String(error);
}

// SAP orchestration keeps its OWN per-model streaming allow-list, and it lags
// behind direct LLM-access support: a freshly-added model (e.g. gpt-5.5) can
// advertise "Streaming Support: Yes" on its Model Library card — that flag
// describes direct /chat/completions — while the orchestration service still
// rejects `client.stream()` with a 400 "Streaming is not supported for this
// model". We can't flip that server-side, but the SDK's non-streaming
// `chatCompletion()` DOES work for these models, so we fall back to it and
// replay the single response through pi's streaming events. This set records
// which model.ids hit the wall so later turns skip the wasted streaming probe
// for the rest of the process; restart pi once SAP enables orchestration
// streaming and the model returns to the streaming path.
const STREAMING_UNSUPPORTED = new Set<string>();

function isStreamingUnsupportedError(error: unknown): boolean {
	// formatError already walks `.cause` and extracts SAP's nested
	// response.data message, so match the fully-resolved string instead of
	// guessing where in the error chain the phrase lives.
	return /streaming is not supported/i.test(formatError(error));
}

// EMPIRICAL FINDING (2026-05-16, verified across gpt-5-mini and
// claude-4.5-sonnet): SAP orchestration strips all detail fields from
// the TokenUsage response. We receive ONLY {prompt_tokens,
// completion_tokens, total_tokens} — no `prompt_tokens_details`, no
// `completion_tokens_details`, no Anthropic-style top-level
// `cache_read_input_tokens`/`cache_creation_input_tokens`. So pi's
// `cacheRead`/`cacheWrite` will always be 0 on SAP-routed turns,
// regardless of whether the backend (OpenAI/Anthropic) actually cached.
// SAP's own contract billing may give you a cache discount that isn't
// visible to this client.
//
// We KEEP the detail-field probes below for defense: if SAP ever flips
// a switch to expose detail fields, the math is already correct. Pi's
// convention is also the OPPOSITE of OpenAI's: `usage.input` is
// non-cached prompt tokens only, with cached tokens accounted for
// separately on `cacheRead`/`cacheWrite`. Don't "simplify" by setting
// `input = prompt_tokens` — that would double-count cache hits if/when
// SAP starts exposing them and inflate cost reporting by ~10× (cacheRead
// is priced at 10% of input on Anthropic).
function mapUsage(usage: TokenUsage): Usage {
	const raw = usage as TokenUsage & {
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	const openAiCached = raw.prompt_tokens_details?.cached_tokens ?? 0;
	const anthropicCached = raw.cache_read_input_tokens ?? 0;
	// In practice these are mutually exclusive per route; max() is defensive.
	const cacheRead = Math.max(openAiCached, anthropicCached);
	const cacheWrite = raw.cache_creation_input_tokens ?? 0;
	const prompt = raw.prompt_tokens ?? 0;
	const input = Math.max(0, prompt - cacheRead - cacheWrite);
	const output = raw.completion_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Anthropic adaptive thinking is only supported on Opus 4.6+, Sonnet 4.6+,
// and Opus 4.7+. Older models (4.0–4.5) reject `thinking: {type: "adaptive"}`
// with "adaptive thinking is not supported on this model" and need the
// classic budget-tokens shape instead. Versioned check rather than a
// hard-coded id list so future tenant extras (5.x etc.) just work.
function anthropicSupportsAdaptive(modelId: string): boolean {
	if (!modelId.startsWith("anthropic--claude-")) return false;
	const m = modelId.match(/^anthropic--claude-(\d+)(?:\.(\d+))?/);
	if (!m) return false;
	const major = Number.parseInt(m[1], 10);
	const minor = m[2] ? Number.parseInt(m[2], 10) : 0;
	return major > 4 || (major === 4 && minor >= 6);
}

// Pi cycles five reasoning levels; Anthropic's budget-tokens API takes a
// raw token count. These defaults mirror what README:108 documents (1k /
// 4k / 8k / 16k / 32k) — and they're what pi-ai's own anthropic provider
// uses for older models. budget_tokens MUST be ≥1024; max_tokens MUST be
// strictly greater than budget_tokens.
const ANTHROPIC_BUDGET_TOKENS: Record<string, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
};

function clampBudget(intended: number, maxTokens: number): number {
	// Leave at least 1024 tokens of room for the actual response; if even
	// that's not possible, give up on thinking for this turn.
	const ceiling = Math.max(0, maxTokens - 1024);
	return Math.min(intended, ceiling);
}

function reasoningParams(
	model: Model<Api>,
	reasoning: string | undefined,
	effectiveMaxTokens: number,
): Partial<LlmModelParams> {
	if (!reasoning || reasoning === "off") return {};

	// SAP orchestration does NOT have a single unified reasoning shape.
	// The right model.params keys are provider-native:
	//   - Anthropic adaptive (4.6+, 4.7+): `thinking: { type: "adaptive" }`
	//     enables reasoning, `output_config: { effort }` controls depth.
	//   - Anthropic budget (4.0–4.5): `thinking: { type: "enabled",
	//     budget_tokens: N }`. output_config is not used; the depth is the
	//     budget itself. SAP rejects adaptive on these models with
	//     "adaptive thinking is not supported on this model".
	//   - OpenAI: `reasoning_effort: "minimal"|"low"|"medium"|"high"`.
	//     SAP rejects `thinking` and `output_config` for openai routes.
	//   - Gemini: unverified at SAP — pi-side we ship gemini-2.5* with
	//     `reasoning: false` so this never fires for them.
	if (model.id.startsWith("anthropic--")) {
		if (anthropicSupportsAdaptive(model.id)) {
			const effort =
				model.thinkingLevelMap?.[
					reasoning as keyof NonNullable<typeof model.thinkingLevelMap>
				];
			if (!effort) return {};
			return {
				thinking: { type: "adaptive" },
				output_config: { effort },
			};
		}
		const intended = ANTHROPIC_BUDGET_TOKENS[reasoning];
		if (!intended) return {};
		// Anthropic requires max_tokens > budget_tokens, so clamp against
		// the EFFECTIVE max_tokens we're actually sending — not the model's
		// hard cap — otherwise pi's tighter budget will 400.
		const budget = clampBudget(intended, effectiveMaxTokens);
		if (budget < 1024) return {}; // not enough headroom to think
		return {
			thinking: { type: "enabled", budget_tokens: budget },
		};
	}
	if (model.id.startsWith("gpt-")) {
		const effort =
			model.thinkingLevelMap?.[
				reasoning as keyof NonNullable<typeof model.thinkingLevelMap>
			];
		if (!effort) return {};
		return { reasoning_effort: effort };
	}
	return {};
}

// gpt-5* on SAP orchestration rejects `temperature` ("Unsupported parameter").
// Mirrors the `temperature: false` flag in models-snapshot.json without forcing
// stream.ts to import the snapshot just for capability lookup.
function modelSupportsTemperature(modelId: string): boolean {
	return !modelId.startsWith("gpt-");
}

function buildLlmParams(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): LlmModelParams {
	// Pi may pass a maxTokens budget smaller than the model's hard cap (e.g.
	// to reserve room for thinking). Respect it; otherwise fall back to the
	// model's documented max output.
	const effectiveMaxTokens = options?.maxTokens ?? model.maxTokens;
	const reasoning = reasoningParams(model, options?.reasoning, effectiveMaxTokens);
	const params: LlmModelParams = {
		max_tokens: effectiveMaxTokens,
	};
	// Anthropic rejects a custom temperature when extended thinking is enabled
	// ("`temperature` may only be set to 1 when thinking is enabled"). Whenever
	// we're sending a `thinking` block, drop temperature so the two
	// incompatible params never go out together. (gpt-* is already excluded by
	// modelSupportsTemperature; it carries reasoning_effort, not `thinking`.)
	const sendingThinking = "thinking" in reasoning;
	if (
		options?.temperature !== undefined &&
		modelSupportsTemperature(model.id) &&
		!sendingThinking
	) {
		params.temperature = options.temperature;
	}
	return {
		...params,
		...reasoning,
	};
}

type ToolCallSlot = {
	contentIndex: number;
	partialJson: string;
};

// What both the streaming and non-streaming paths hand to the shared
// finalizer: the resolved finish reason, any accumulated refusal, and raw
// SAP token usage (mapped + costed once, in `finishTurn`).
type TurnResult = {
	finishReason: string | undefined;
	refusalText: string;
	usage: TokenUsage | undefined;
};

// SAP's `ChatDelta` schema is `{role?, content, refusal?, tool_calls?} & Record<string, any>`.
// The Record<string,any> is a deliberate passthrough for vendor-native
// streaming fields. The SDK only exposes `getDeltaContent()` and
// `getDeltaToolCalls()`; everything else we have to dig out of
// `findChoiceByIndex(0)?.delta` ourselves.
//
// EMPIRICAL FINDING (2026-05-16, opus 4.6 + gpt-5-mini): SAP orchestration
// does NOT pass reasoning/thinking content through. Deltas contain only
// `role` and `content`. The model genuinely reasons (token usage reflects
// it, and step-by-step structure leaks into the visible text), but the
// structured thinking block pi expects to render in its UI panel never
// arrives. Refusals also weren't observed; OpenAI moderation may inline
// them into `content` rather than `refusal`.
//
// We keep the `pickReasoning` / refusal machinery below in place anyway:
// (a) it's a few function calls per chunk, (b) if SAP ever flips a switch
// to expose reasoning text, our extension picks it up with no further
// changes. Don't be tempted to delete it as "dead code".
type ExtendedDelta = {
	content?: string | null;
	refusal?: string | null;
	// OpenAI-compat reasoning passthrough (DeepSeek, gpt-5 via SAP, etc.)
	reasoning_content?: string | null;
	reasoning?: string | null;
	reasoning_text?: string | null;
	// Anthropic-via-SAP may pass through native thinking as a string or
	// as a content-block array. Mirror both shapes defensively.
	thinking?:
		| string
		| Array<{ type?: string; thinking?: string; text?: string }>
		| null;
	[key: string]: unknown;
};

const REASONING_FIELDS = [
	"reasoning_content",
	"reasoning",
	"reasoning_text",
] as const;

// Returns the first non-empty reasoning chunk on the delta, plus the
// field name it came from. Latching the field name across chunks avoids
// double-counting providers that emit both `reasoning` and
// `reasoning_content` with identical content (chutes.ai etc. do this —
// pi-ai's openai-completions provider applies the same defense).
function pickReasoning(
	delta: ExtendedDelta,
	preferredField: string | undefined,
): { text: string; field: string } | undefined {
	if (preferredField) {
		const v = delta[preferredField];
		if (typeof v === "string" && v.length > 0)
			return { text: v, field: preferredField };
	}
	for (const field of REASONING_FIELDS) {
		if (field === preferredField) continue;
		const v = delta[field];
		if (typeof v === "string" && v.length > 0) return { text: v, field };
	}
	const native = delta.thinking;
	if (typeof native === "string" && native.length > 0) {
		return { text: native, field: "thinking" };
	}
	if (Array.isArray(native)) {
		const joined = native
			.map((b) => (b?.type === "thinking" ? b.thinking : b?.text) ?? "")
			.join("");
		if (joined.length > 0) return { text: joined, field: "thinking" };
	}
	return undefined;
}

// Latch finish reasons across chunks. SAP can emit a real reason (e.g.
// "tool_calls") on chunk N and then a later "stop" on chunk N+1 — taking
// the last value loses the meaningful one. Latch the first non-empty;
// also bias toward "tool_calls" so toolUse always wins over a trailing
// "stop" (which happens after the tool args complete).
function latchFinishReason(
	current: string | undefined,
	next: string | undefined,
): string | undefined {
	if (!next) return current;
	if (next === "tool_calls" || next === "function_call") return next;
	if (current === "tool_calls" || current === "function_call") return current;
	return current ?? next;
}

let lastValidatedKey: ValidatedKey | undefined;

function ensureServiceKey(apiKey: string | undefined): ValidatedKey {
	// pi passes the oauth-stored service-key JSON here (after `/login`). When the
	// provider is unconfigured, pi instead passes our registration placeholder (a
	// non-JSON literal) — treat anything that doesn't look like the JSON object as
	// "no key from pi" and fall back to the AICORE_SERVICE_KEY env override.
	const fromPi = apiKey?.trimStart().startsWith("{") ? apiKey : undefined;
	const raw = fromPi ?? process.env.AICORE_SERVICE_KEY;
	if (!raw) {
		throw new Error(
			"No SAP AI Core service key configured. Run `/login` in pi, " +
				"pick 'Use a subscription' → 'SAP AI Core', and paste your BTP " +
				"service-key JSON. Or set AICORE_SERVICE_KEY in your shell.",
		);
	}

	if (lastValidatedKey?.raw === raw) return lastValidatedKey;

	const validated = parseAndValidateServiceKey(raw);
	lastValidatedKey = validated;
	return validated;
}

// Resolve the SAP AI Core resource group with this precedence:
//   1. AICORE_RESOURCE_GROUP env var (per-shell override).
//   2. `resourceGroup` field on the service-key JSON (per-tenant default).
//   3. undefined — SAP server-side defaults to "default".
function resolveResourceGroup(key: ValidatedKey): string | undefined {
	const fromEnv = process.env.AICORE_RESOURCE_GROUP?.trim();
	if (fromEnv) return fromEnv;
	return key.resourceGroup;
}

export function streamSapAiCore(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		const requestId = randomUUID();
		try {
			stream.push({ type: "start", partial: output });

			const serviceKey = ensureServiceKey(options?.apiKey);
			process.env.AICORE_SERVICE_KEY = serviceKey.raw;
			const resourceGroup = resolveResourceGroup(serviceKey);

			const { messages, tools } = piContextToOrchestration(context);

			const { OrchestrationClient } = await importOrchestration();
			const llmParams = buildLlmParams(model, options);

			debugLog({
				requestId,
				kind: "request",
				model: model.id,
				resourceGroup,
				params: llmParams,
				messageRoles: messages.map((m) => m.role),
				messages,
			});

			const client = new OrchestrationClient(
				{
					promptTemplating: {
						model: {
							name: model.id as ChatModel,
							params: llmParams,
						},
						prompt: {
							template: [],
							...(tools.length > 0 ? { tools } : {}),
						},
					},
				},
				// SAP's typings reject AI-Resource-Group as a header
				// (`'AI-Resource-Group'?: never`); the only supported path is
				// the deploymentConfig constructor arg. Omit when undefined
				// so SAP falls back to its server-side default ("default").
				resourceGroup ? { resourceGroup } : undefined,
			);

			// Shared finalizer for both paths: map+cost usage once, promote a
			// refusal to a visible error, otherwise emit the `done` event.
			const finishTurn = (result: TurnResult) => {
				if (result.usage) {
					output.usage = mapUsage(result.usage);
					calculateCost(model, output.usage);
				}

				// A refusal terminates the turn with no real content. Promote
				// it to errorMessage and emit an error event so pi surfaces
				// it visibly instead of showing an empty assistant turn.
				if (result.refusalText) {
					output.stopReason = "error";
					output.errorMessage = `Model refused: ${result.refusalText}`;
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}

				output.stopReason = mapFinishReason(result.finishReason);
				stream.push({
					type: "done",
					reason: output.stopReason as "stop" | "length" | "toolUse",
					message: output,
				});
				stream.end();
			};

			// Non-streaming fallback for models SAP orchestration refuses to
			// stream (see STREAMING_UNSUPPORTED). One blocking chatCompletion,
			// replayed through pi's streaming events as a single text/tool block.
			const runBlocking = async (): Promise<TurnResult> => {
				const blocking = await client.chatCompletion(
					{ messages },
					options?.signal ? { signal: options.signal } : undefined,
				);

				// getRefusal() first: getContent() throws on a filtered turn,
				// and a refusal is exactly that case.
				const refusal = blocking.getRefusal();
				if (refusal) {
					return {
						finishReason: blocking.getFinishReason(),
						refusalText: refusal,
						usage: blocking.getTokenUsage(),
					};
				}

				const content = blocking.getContent();
				if (content) {
					output.content.push({ type: "text", text: content });
					const idx = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: idx, partial: output });
					stream.push({
						type: "text_delta",
						contentIndex: idx,
						delta: content,
						partial: output,
					});
					stream.push({
						type: "text_end",
						contentIndex: idx,
						content,
						partial: output,
					});
				}

				for (const tc of blocking.getToolCalls() ?? []) {
					let parsedArgs: Record<string, unknown> = {};
					if (tc.function.arguments) {
						try {
							parsedArgs = JSON.parse(tc.function.arguments);
						} catch {
							// Model emitted invalid JSON — leave args empty rather
							// than crash; mirrors the streaming path's tolerance.
						}
					}
					output.content.push({
						type: "toolCall",
						id: tc.id,
						name: tc.function.name,
						arguments: parsedArgs,
					});
					const idx = output.content.length - 1;
					stream.push({
						type: "toolcall_start",
						contentIndex: idx,
						partial: output,
					});
					if (tc.function.arguments) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: idx,
							delta: tc.function.arguments,
							partial: output,
						});
					}
					stream.push({
						type: "toolcall_end",
						contentIndex: idx,
						toolCall: {
							type: "toolCall",
							id: tc.id,
							name: tc.function.name,
							arguments: parsedArgs,
						},
						partial: output,
					});
				}

				return {
					finishReason: blocking.getFinishReason(),
					refusalText: "",
					usage: blocking.getTokenUsage(),
				};
			};

			// Stream by default; on SAP's "Streaming is not supported" 400 —
			// and only before any chunk has been emitted — remember the model
			// and fall back to the blocking path so the turn still completes.
			let response: Awaited<ReturnType<typeof client.stream>> | undefined =
				undefined;
			if (!STREAMING_UNSUPPORTED.has(model.id)) {
				try {
					response = await client.stream({ messages }, options?.signal, {
						promptTemplating: { include_usage: true },
					});
				} catch (error) {
					if (
						!isStreamingUnsupportedError(error) ||
						output.content.length > 0
					) {
						throw error;
					}
					STREAMING_UNSUPPORTED.add(model.id);
					debugLog({
						requestId,
						kind: "stream-fallback",
						model: model.id,
						reason: "orchestration-streaming-unsupported",
					});
				}
			}

			if (!response) {
				finishTurn(await runBlocking());
				return;
			}

			let textIndex = -1;
			let thinkingIndex = -1;
			let reasoningField: string | undefined;
			let refusalText = "";
			const toolSlots = new Map<number, ToolCallSlot>();
			let finishReason: string | undefined;

			const closeText = () => {
				if (textIndex < 0) return;
				const block = output.content[textIndex];
				if (block?.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: textIndex,
						content: block.text,
						partial: output,
					});
				}
				textIndex = -1;
			};

			const closeThinking = () => {
				if (thinkingIndex < 0) return;
				const block = output.content[thinkingIndex];
				if (block?.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: block.thinking,
						partial: output,
					});
				}
				thinkingIndex = -1;
			};

			for await (const chunk of response.stream) {
				if (options?.signal?.aborted) break;

				const choice = chunk.findChoiceByIndex(0);
				const rawDelta = (choice?.delta ?? {}) as ExtendedDelta;

				// Reasoning first — most providers emit reasoning chunks
				// before the visible text, and pi's UI expects a
				// thinking block to precede the text block in
				// output.content ordering.
				const reasoning = pickReasoning(rawDelta, reasoningField);
				if (reasoning) {
					reasoningField = reasoning.field;
					if (thinkingIndex < 0) {
						closeText();
						output.content.push({ type: "thinking", thinking: "" });
						thinkingIndex = output.content.length - 1;
						stream.push({
							type: "thinking_start",
							contentIndex: thinkingIndex,
							partial: output,
						});
					}
					const block = output.content[thinkingIndex];
					if (block?.type === "thinking") {
						block.thinking += reasoning.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: thinkingIndex,
							delta: reasoning.text,
							partial: output,
						});
					}
				}

				const delta = chunk.getDeltaContent();
				if (delta) {
					if (textIndex < 0) {
						closeThinking();
						output.content.push({ type: "text", text: "" });
						textIndex = output.content.length - 1;
						stream.push({
							type: "text_start",
							contentIndex: textIndex,
							partial: output,
						});
					}
					const block = output.content[textIndex];
					if (block?.type === "text") {
						block.text += delta;
						stream.push({
							type: "text_delta",
							contentIndex: textIndex,
							delta,
							partial: output,
						});
					}
				}

				// Refusals from SAP's content filter or the underlying
				// provider (OpenAI moderation, etc.). Accumulate
				// across chunks; surface as the final error message so
				// the user sees something instead of an empty turn.
				if (
					typeof rawDelta.refusal === "string" &&
					rawDelta.refusal.length > 0
				) {
					refusalText += rawDelta.refusal;
				}

				const toolDeltas = chunk.getDeltaToolCalls();
				if (toolDeltas && toolDeltas.length > 0) {
					closeText();
					closeThinking();

					for (const td of toolDeltas) {
						let slot = toolSlots.get(td.index);
						if (!slot) {
							output.content.push({
								type: "toolCall",
								id: td.id ?? "",
								name: td.function?.name ?? "",
								arguments: {},
							});
							slot = {
								contentIndex: output.content.length - 1,
								partialJson: "",
							};
							toolSlots.set(td.index, slot);
							stream.push({
								type: "toolcall_start",
								contentIndex: slot.contentIndex,
								partial: output,
							});
						}

						const block = output.content[slot.contentIndex];
						if (block?.type === "toolCall") {
							if (td.id && !block.id) block.id = td.id;
							if (td.function?.name && !block.name)
								block.name = td.function.name;

							const fragment = td.function?.arguments ?? "";
							if (fragment) {
								slot.partialJson += fragment;
								try {
									block.arguments = JSON.parse(slot.partialJson);
								} catch {
									// Partial JSON — keep accumulating until valid
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: slot.contentIndex,
									delta: fragment,
									partial: output,
								});
							}
						}
					}
				}

				finishReason = latchFinishReason(finishReason, chunk.getFinishReason());
			}

			closeText();
			closeThinking();

			for (const slot of toolSlots.values()) {
				const block = output.content[slot.contentIndex];
				if (block?.type === "toolCall") {
					if (slot.partialJson) {
						try {
							block.arguments = JSON.parse(slot.partialJson);
						} catch {
							// Leave arguments as last successfully-parsed value
						}
					}
					stream.push({
						type: "toolcall_end",
						contentIndex: slot.contentIndex,
						toolCall: {
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.arguments,
						},
						partial: output,
					});
				}
			}

			finishTurn({
				finishReason: finishReason ?? response.getFinishReason(),
				refusalText,
				usage: response.getTokenUsage(),
			});
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			debugLog({
				requestId,
				kind: "error",
				model: model.id,
				stopReason: output.stopReason,
				error: output.errorMessage,
			});
			stream.push({
				type: "error",
				reason: output.stopReason as "error" | "aborted",
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}
