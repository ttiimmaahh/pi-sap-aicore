# pi-sap-aicore

A custom provider extension for the [pi coding agent](https://pi.dev) that routes
inference through **SAP AI Core orchestration**.

> Status: **Phase 2 (scaffold)** — models register and appear in `pi --list-models`,
> but inference is not wired up yet. Phase 3 implements the orchestration streaming
> adapter against `@sap-ai-sdk/orchestration`.

## Prerequisites

- pi installed (`npm install -g @earendil-works/pi-coding-agent`)
- An SAP BTP account with AI Core entitlement and an **orchestration deployment**
- The service key JSON for your AI Core service binding

## Credentials

The extension looks for the SAP BTP service-key JSON in this order:

1. **`AICORE_SERVICE_KEY` environment variable** — per-shell override, always
   wins. Useful when you need to point at a different tenant for one session.
2. **Pi's native auth store** — `~/.pi/agent/auth.json`, populated by
   `/login sap-aicore`. Persisted across sessions, file-permission-locked by pi.

If neither is present, inference fails with a clear "no service key" error.

### Recommended: `/login sap-aicore`

From inside pi:

```
/login sap-aicore
```

Pi will prompt for your BTP service-key JSON. Paste it as a single line and
hit enter. Pi stores it in `~/.pi/agent/auth.json` for future sessions.

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

### Multi-machine install (once pushed to a git remote)

```bash
pi install git:github.com/<your-user>/<repo>@main
```

pi will clone, run `npm install`, and auto-load the extension on every startup.
Repeat the one command on each machine. Update with `pi update`.

## Models

The model list lives in [`src/models-config.ts`](./src/models-config.ts) using a
schema mirroring [models.dev](https://models.dev) (and the user's existing
opencode `sap-ai-core` provider config). To add a new model:

1. Add a `SapModel` entry — the `id` must match the SAP orchestration
   `llm_module_config.model_name` value.
2. Set `backend: "anthropic"` or `"openai"` — drives how pi preprocesses the
   request before our streamSimple translates it to orchestration's envelope.
3. Restart pi (or `/reload`).

### Pricing

The `cost` fields are vendor list prices (USD per million tokens) used **only**
for pi's in-UI cost display. Your actual SAP BTP invoice is contract-based and
will differ. Update the numbers in `models-config.ts` if you want the display to
reflect your real rates.

## What's not yet implemented (Phase 3+)

- The `streamSimple` adapter currently returns a clear error event. Phase 3
  wires it to `@sap-ai-sdk/orchestration` (text deltas, thinking, tool calls,
  abort signal, usage accounting).
- XSUAA bearer token refresh via pi's `oauth` config wrapper (so pi handles
  the ~12h token rotation transparently).
- Orchestration module configuration surface (content filtering, masking,
  grounding) — request builder will be stubbed for later wiring.

## Repo layout

```
.
├── package.json          # pi-package manifest + deps
├── tsconfig.json         # editor support; pi runs the .ts directly
├── index.ts              # ExtensionAPI factory + registerProvider call
└── src/
    ├── models-config.ts  # SapModel[] (the one file you edit to add models)
    └── to-pi-model.ts    # SapModel → pi's ProviderModelConfig mapper
```
