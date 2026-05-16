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

The model list lives in [`src/models-config.ts`](./src/models-config.ts) using a
schema mirroring [models.dev](https://models.dev). To add a new model:

1. Add a `SapModel` entry — the `id` must match the SAP orchestration
   `llm_module_config.model_name` value.
2. Restart pi (or `/reload`).

The `cost` fields are vendor list prices (USD per million tokens) used **only**
for pi's in-UI cost display. Your actual SAP BTP invoice is contract-based and
will differ. Update the numbers in `models-config.ts` if you want the display to
reflect your real rates.

## AI Resource Group

The extension currently hardcodes `AI-Resource-Group: default` (in `index.ts`).
If your SAP AI Core deployment lives in a different resource group, edit that
header value. A future iteration may make this configurable per-session.

## Repo layout

```
.
├── package.json          # pi-package manifest + deps
├── tsconfig.json         # editor support; pi runs the .ts directly
├── index.ts              # ExtensionAPI factory + registerProvider call
└── src/
    ├── models-config.ts  # SapModel[] (the one file you edit to add models)
    ├── to-pi-model.ts    # SapModel → pi's ProviderModelConfig mapper
    ├── stream.ts         # streamSimple adapter (validates key, runs OrchestrationClient)
    └── translate.ts      # pi Context ↔ SAP orchestration message shape
```
