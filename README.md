# pi-sap-aicore

A custom provider extension for the [pi coding agent](https://pi.dev) that routes
inference through **SAP AI Core orchestration**.

## Prerequisites

- pi **0.78.0 or newer** installed (`npm install -g @earendil-works/pi-coding-agent`)
- An SAP BTP account with AI Core entitlement and an **orchestration deployment**
- The service key JSON for your AI Core service binding

## Credentials

The extension looks for the SAP BTP service-key JSON in this order:

1. **Pi's auth store** — `~/.pi/agent/auth.json`, populated by `/login` (see below).
   Persisted across sessions, file-permission-locked by pi.
2. **`AICORE_SERVICE_KEY` environment variable** — per-shell override. Useful for
   testing against a different tenant for one session without re-running `/login`.

If neither is present, inference fails with a clear "no service key configured" error.

### Recommended: `/login`

From inside pi:

```
/login
```

Then:
1. Pick **Use a subscription**.
2. Pick **SAP AI Core**.
3. At the prompt, paste your BTP service-key JSON as a single line and hit enter.
   It's validated immediately — if anything is missing or malformed, you'll get a
   specific error pointing at the field, so you can re-run `/login` and fix it.

Pi stores the JSON in `~/.pi/agent/auth.json` for future sessions.

To get the JSON: BTP cockpit → your AI Core service instance → Service Keys
→ View. Copy the entire JSON object.

> **Why "Use a subscription" and not "Use an API key"?** SAP service keys contain
> a `$` in their `clientsecret`. Since pi 0.77, keys stored via "Use an API key"
> are run through a `$`-interpolating template resolver that mangles them. The
> extension registers credentials through pi's `oauth` mechanism instead, which
> stores and returns the key verbatim. It's not real OAuth — it's just the path
> that keeps your key intact. (See [pi issue #5095](https://github.com/earendil-works/pi/issues/5095).)

> **Upgrading from an older install?** If you previously logged in via
> "Use an API key" (stored as `{"type":"api_key"}` in `auth.json`), re-run
> `/login` **once** via **Use a subscription** to convert the stored credential.
> A single re-login is all that's needed.

### Alternative: `AICORE_SERVICE_KEY` env var

```bash
export AICORE_SERVICE_KEY='{"clientid":"...","clientsecret":"...","url":"https://...authentication.sap.hana.ondemand.com","serviceurls":{"AI_API_URL":"https://api.ai.<region>.ml.hana.ondemand.com"}}'
```

The `@sap-ai-sdk/orchestration` SDK reads this directly for XSUAA auth, token
caching, and deployment resolution — no manual token plumbing needed.

## Install

### Local development (this repo)

```bash
npm install
pi -e ./index.ts --list-models
```

You should see two models under `sap-aicore/`:
- `sap-aicore/anthropic--claude-4.7-opus` — Claude Opus 4.7
- `sap-aicore/gpt-5.4` — GPT-5.4

Run `pi -e ./index.ts` to launch pi with the local extension loaded; this
overrides any globally-installed version for the session, which is the fastest
iteration loop while developing.

### Multi-machine install (once pushed to a git remote)

```bash
pi install git:github.com/<your-user>/<repo>@main
```

pi will clone, run `npm install`, and auto-load the extension on every startup.
Repeat the one command on each machine. Update with `pi update`.

## Models

The model list is composed of two sources, merged at startup:

1. **`src/models-snapshot.json`** — auto-generated from
   [models.dev](https://models.dev)'s SAP AI Core catalog. Refresh with:
   ```bash
   npm run update-models
   ```
   This re-fetches the live catalog, applies our family-specific filters
   (currently anthropic claude-4.x, gpt-5*, gemini-2.5*), and writes the
   snapshot to disk. Commit the result.

2. **`TENANT_EXTRAS` in [`src/models-config.ts`](./src/models-config.ts)** —
   hand-maintained list of models that exist in your SAP tenant but
   aren't (yet) in the models.dev catalog. Same `SapModel` shape. Extras
   win over snapshot on duplicate `id`.

To add a model that everyone on your team should see, add it to
`TENANT_EXTRAS` and commit. To add a per-machine custom (your own tenant
only), use pi's built-in custom-models mechanism by editing
`~/.pi/agent/models.json` — no extension changes required.

The `cost` fields are vendor list prices (USD per million tokens) from
models.dev. Used **only** for pi's in-UI cost display — your actual SAP
BTP invoice is contract-based and will differ.

## Thinking levels

Models with `reasoning: true` honor pi's thinking-level cycle (default
keybind `Shift+Tab`): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

- **Anthropic 4.6+ models** (`anthropic--claude-4.6-*`, `4.7-*`) use
  *adaptive* thinking — `thinking: {type: "adaptive"}` + `output_config:
  {effort}`. The model decides the budget; the level only nudges depth.
- **Older Anthropic models** (`anthropic--claude-4-*`, `4.5-*`) use
  *budget-token* thinking — `thinking: {type: "enabled", budget_tokens: N}`.
  Each pi level maps to a token count (1k / 4k / 8k / 16k / 32k for
  minimal/low/medium/high/xhigh), clamped down so `max_tokens` always
  has at least 1024 tokens of headroom for the response. SAP rejects
  the adaptive shape on these models ("adaptive thinking is not
  supported on this model"), which is why we split.

**Note on reasoning visibility:** SAP orchestration does NOT pass
structured reasoning/thinking content through to streaming clients.
The model genuinely reasons (you'll see step-by-step structure leak
into the visible answer text, and the tokens are billed via
`completion_tokens_details.reasoning_tokens`), but pi's dedicated
"thinking" panel will stay empty for SAP-routed models — there's no
client-side fix. If SAP exposes a server-side flag for this in the
future, our `pickReasoning` probe is wired and ready in `stream.ts`.
- **OpenAI models** (`gpt-*`) use `reasoning_effort: "minimal" | "low"
  | "medium" | "high"`. `xhigh` is omitted — OpenAI has no equivalent
  tier; pi will skip it when cycling.
- **Gemini models** (`gemini-2.5-*`) ship with `reasoning: false` —
  SAP's gemini reasoning passthrough is undocumented, so we keep
  `Shift+Tab` off the cycle for these models rather than send a request
  shape SAP may reject. Wire-up (likely `thinking_config.thinking_budget`)
  is a future TODO in `src/stream.ts:reasoningParams`.

To override budgets per model, edit `thinkingLevelMap` on the relevant
entry in `TENANT_EXTRAS`, or override per-user via pi's `models.json`.

## AI Resource Group

Resolved in this order:

1. **`AICORE_RESOURCE_GROUP` env var** — per-shell override. Example:
   ```bash
   export AICORE_RESOURCE_GROUP=my-team-rg
   ```
2. **`resourceGroup` field on the service-key JSON** — convenient for teams
   who manage multiple groups and want to bake the default into the key.
   Non-standard, so add it yourself before pasting into pi:
   ```json
   { "clientid": "...", "clientsecret": "...", "resourceGroup": "my-team-rg", ... }
   ```
3. **SAP's server-side default** (`default`) — if neither of the above is set.

The value is passed via SAP's `OrchestrationClient(..., {resourceGroup})`
constructor arg, which is the only supported channel — `AI-Resource-Group`
as a request header is explicitly rejected by SAP's typings.

## Prompt caching & cost reporting

**Cache read/write tokens always report 0** on SAP-routed turns. SAP
orchestration strips all detail fields from the TokenUsage response
— we only get `prompt_tokens`, `completion_tokens`, and `total_tokens`
across every route. There's no `prompt_tokens_details.cached_tokens`
(OpenAI) and no top-level `cache_read_input_tokens` (Anthropic) for
the client to read.

Whether the backend actually caches is invisible to pi. SAP's
contract billing may give you a discount on cached tokens that this
extension can't surface — check your BTP invoice if cache savings
matter.

**Experimental:** `PI_SAP_AICORE_CACHE_CONTROL=1` tags the system
prompt and last user message with Anthropic's `cache_control:
{type:"ephemeral"}`. SAP may forward it (saving SAP money on the
backend, possibly passed through via your contract) or may 400 the
request. Either way, you won't see cacheRead become non-zero in pi's
diagnostics — that requires SAP to expose detail fields, which they
currently don't.

OpenAI/Gemini routes ignore the flag — they have their own automatic
caching with no breakpoint API.

## Repo layout

```
.
├── package.json              # pi-package manifest + deps + scripts
├── tsconfig.json             # editor support; pi runs the .ts directly
├── index.ts                  # ExtensionAPI factory + registerProvider call
├── scripts/
│   └── update-models.mjs     # fetches models.dev, writes models-snapshot.json
└── src/
    ├── models-config.ts      # loads snapshot + merges TENANT_EXTRAS
    ├── models-snapshot.json  # auto-generated from models.dev (committed)
    ├── to-pi-model.ts        # SapModel → pi's ProviderModelConfig mapper
    ├── stream.ts             # streamSimple adapter (key validation, reasoning, OrchestrationClient)
    └── translate.ts          # pi Context ↔ SAP orchestration message shape
```
