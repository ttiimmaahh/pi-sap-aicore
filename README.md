# pi-sap-aicore

A custom provider extension for the [pi coding agent](https://pi.dev) that routes
inference through **SAP AI Core orchestration**.

## Prerequisites

- pi installed (`npm install -g @earendil-works/pi-coding-agent`)
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
1. Pick **Use an API key**.
2. Pick **SAP AI Core**.
3. At the `Enter API key:` prompt, paste your BTP service-key JSON as a
   single line and hit enter.

Pi stores the JSON in `~/.pi/agent/auth.json` for future sessions. The
extension validates the JSON shape on first chat — if anything is missing or
malformed, you'll get a specific error pointing at the field.

To get the JSON: BTP cockpit → your AI Core service instance → Service Keys
→ View. Copy the entire JSON object.

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

- **Anthropic models** (`anthropic--claude-*`) use Anthropic's extended
  thinking. Each level maps to a `budget_tokens` value (1k / 4k / 8k /
  16k / 32k by default; scaled down if the model's max output is smaller).
- **OpenAI models** (`gpt-*`) use `reasoning_effort: "minimal" | "low"
  | "medium" | "high"`. `xhigh` is omitted — OpenAI has no equivalent
  tier; pi will skip it when cycling.
- **Other families** (gemini, etc.) currently pass through without
  reasoning params — `Shift+Tab` is a no-op. Wire-up is a future TODO.

To override budgets per model, edit `thinkingLevelMap` on the relevant
entry in `TENANT_EXTRAS`, or override per-user via pi's `models.json`.

## AI Resource Group

The extension currently hardcodes `AI-Resource-Group: default` (in `index.ts`).
If your SAP AI Core deployment lives in a different resource group, edit that
header value. A future iteration may make this configurable per-session.

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
