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

Commands: `/sap-models update|discover|list|paths|help`.
Maintainer snapshot refresh: `scripts/update-models.mjs`.

## Providers registered

Registers two model providers:

- `sap-aicore` (orchestration) — the ONLY one that should register
  `oauth: sapAiCoreOAuth`.
- `sap-aicore-foundation` (direct foundation) — shares the service key via the
  `ensureServiceKey` auth-store fallback. Do NOT register oauth on foundation too, or
  `/login → Use a subscription` shows duplicate `SAP AI Core` entries (Pi keys OAuth
  providers by provider id, not oauth display name).

## Validation

Pi loads `index.ts` directly. Validate changes with:

- `npx tsc --noEmit`
- `pi -e ./index.ts --list-models sap-aicore`
- import smoke tests

## Notes

- SAP reasoning maps to `output_config.effort` (low / medium / high).
