# AGENTS.md

Guidance for AI coding agents working in the **pi-sap-aicore** repo (a custom Pi
model provider). Read this before making changes.

## Repo layout & identity

- Repo: `ttiimmaahh/pi-sap-aicore`

## Contributing

Read `CONTRIBUTING.md` before opening a PR or changing dependencies, workflows, or
build scripts.

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
`scripts/update-models.mjs`. Both refresh paths import every entry from models.dev's
`sap-ai-core` catalog; model selection and overlay exclusions belong to the user.

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

## Message translation

Every stream entry point passes context through `normalizeContext()`
(`src/normalize-context.ts`) before translating. It accepts legacy contexts and
Pi 0.87+ transcripts, replays system prompt/tool deltas with local structural types
that also compile against older Pi versions, then removes system messages before
repairing tool-call pairs. A system update between a tool call and its result
must not create a synthetic result.
Message repair drops errored/aborted turns and answers orphaned tool calls;
skipping it can wedge sessions with `"tool_call_ids did not have response messages"`.

`normalizeContext()` also encodes `options.toolChoice` (pi 0.84.3+): `"none"` —
which pi sets on summarization/compaction turns — sends no tools at all, because
that is the only expression of "none" every backend here accepts. Do not
translate it into a per-backend `tool_choice` field.

The four translators must each keep an assistant `tool_calls` message immediately
followed by one tool/tool_result entry per id. Image tool results get hoisted into a
synthetic user message, so hoisted content goes **after** the whole tool block, never
between two of its entries. `src/translate.ts` and `src/translate-foundation.ts` share
these rules — fix both together.

## Validation

The published package loads `dist/index.js`, a bundle of `index.ts` and the SAP SDKs
built by `scripts/build.mjs`. Pi's standalone Bun runtime cannot load the unbundled
`index.ts` (`logform -> fecha` fails to resolve), so test `dist/` for anything that
has to hold in a release. `@sap/xssec` and `@sap/xsenv` are under SAP's Developer
License, so they stay external and `scripts/bundle-banner.js` loads them; the build
fails if a package with a restricted license gets bundled. Validate changes with:

- `npx tsc --noEmit`
- `npm test`
- `npm run build`, then `pi -ne -e ./dist/index.js --list-models sap-aicore --offline`
  and the same for `sap-aicore-foundation`
- `npm run test:bundle` for a real prompt on every SAP route, on Node and Bun.
  A bundle can load and still fail on its first request, so a load check is not enough
- `npm run test:startup` for the full installed-extension set
- import smoke tests

Use `-ne -e` for standalone probes: `-e` alone also loads the installed copy,
which can override the working tree's providers and hide failures.

## Notes

- Minimum supported versions are Pi 0.81.0 and Node.js 22.19.0; the dev/CI
  baseline is recorded in `package.json` and `package-lock.json`.
- SAP reasoning maps to `output_config.effort` (low / medium / high).
