# AGENTS.md

Guidance for AI coding agents working in the **pi-sap-aicore** repo (a custom Pi
model provider). Read this before making changes.

## Repo layout & identity

- Repo: `ttiimmaahh/pi-sap-aicore`
- Active source: `~/Developer/gitroot/personal/pi-extensions/pi-sap-aicore`
- Runtime checkout Pi loads from: `~/.pi/agent/git/github.com/ttiimmaahh/pi-sap-aicore`

## Model catalog

The model catalog is a layered **snapshot / cache / overlay**:

- `src/models-snapshot.json` — bundled snapshot
- `~/.pi/agent/pi-sap-aicore/models-cache.json` — runtime cache
- `models.json` — overlay with `models` / `overrides` / `exclude` /
  `foundation.enabledModelIds`

`src/model-catalog-controller.ts` owns the shared synchronous catalog and deduplicates
Pi refreshes across both providers. It intentionally keeps the extension's cache
format instead of writing Pi's generic ModelsStore. Commands:
`/sap-models update|discover|list|paths|help`. Maintainer snapshot refresh:
`scripts/update-models.mjs`.

## Providers registered

`src/providers.ts` registers two complete Pi 0.81 `Provider` objects:

- `sap-aicore` (orchestration) owns native API-key auth and the legacy OAuth
  compatibility handler, so existing 0.3.x credentials keep working.
- `sap-aicore-foundation` (direct foundation) has no custom login or OAuth method.
  Its auth resolver shares the primary provider's stored `api_key` or legacy
  `oauth` service key. Pi may still compose/list an API-key setup entry because
  every Provider must declare auth. Do not add OAuth here: that recreates the
  duplicate SAP subscription entry.

Credential storage access belongs in `src/auth.ts`, not stream transports. Provider
refresh mutates the shared controller's view; never re-register providers to publish
new models.

## Validation

Pi loads `index.ts` directly. Validate changes with:

- `npx tsc --noEmit`
- `npm test`
- `pi -e ./index.ts --list-models sap-aicore`
- `pi -e ./index.ts --list-models sap-aicore-foundation`
- import smoke tests

## Notes

- Minimum supported versions are Pi 0.81.0 and Node.js 22.19.0.
- SAP reasoning maps to `output_config.effort` (low / medium / high).
