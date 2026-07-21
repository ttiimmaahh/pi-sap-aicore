# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-07-21

### Changed

- Validated against Pi 0.81.1 and pinned the development/CI baseline to it. Pi
  0.81.1 is a hotfix release (resilient compaction and branch-summary retries, a
  restored default stream fallback for pre-0.81 extensions, and an interactive
  startup fix) whose changes are internal to Pi; the native orchestration and
  foundation providers, credential storage, and catalog refresh continue to work
  unchanged with no extension code changes required. The minimum supported Pi
  version remains 0.81.0.

## [0.4.0] - 2026-07-21

### Added

- Registered complete Pi 0.81 `Provider` objects for both orchestration and
  foundation routes, including native authentication, synchronous model views,
  provider refresh, and both streaming methods.
- Added native API-key login for SAP service-key JSON. Pi stores and resolves the
  credential verbatim, preserving literal `$` characters in `clientsecret`.
- Integrated the layered SAP catalog with Pi's provider refresh lifecycle. `/model`
  and `pi update --models` can refresh it automatically, while `/sap-models update`
  forces an immediate refresh without replacing Provider objects.
- Added offline regression coverage for native Provider shape, API-key and legacy
  auth, shared foundation credentials, refresh throttling, abort/failure retention,
  concurrent refresh deduplication, and stale-cache protection.

### Changed

- Existing fake-OAuth credentials remain supported without re-login, but new users
  should authenticate through `/login` → **Sign in with an API key**.
- Raised the minimum supported Pi version to 0.81.0 and Node.js to 22.19.0.
  Users remaining on Pi 0.80.x should pin `pi-sap-aicore@0.3.8`.
- Older per-machine model caches no longer override a newer bundled snapshot after
  an extension upgrade.

### Fixed

- Declared `@sap-ai-sdk/core` as a direct dependency because the Bedrock and Vertex
  adapters import it directly; strict and pnpm installations no longer depend on
  transitive hoisting.

## [0.3.8] - 2026-07-18

### Fixed

- SAP AI Core no longer appears configured in `/login` on a fresh install.
  The orchestration provider now declares its `AICORE_SERVICE_KEY` environment
  fallback explicitly instead of using an always-configured placeholder; stored
  subscription credentials continue to use the existing OAuth-backed login.

## [0.3.7] - 2026-07-16

### Fixed

- Restored shared `/login` credentials for `sap-aicore-foundation` and
  `/sap-models discover` on Pi 0.80.9+. Pi replaced the old synchronous
  `AuthStorage.list()` / `get()` API; the extension now uses the public
  `readStoredCredential()` helper and reads only the `sap-aicore` credential.
  Previously the compatibility error was swallowed and every model request
  incorrectly reported that no service key was configured.

### Added

- Added `scripts/test-auth-storage.mjs`, an isolated regression test that checks
  shared credential lookup, literal `$` preservation, provider isolation, and
  credential-type validation.

### Changed

- Raised the Pi peer and development dependency floor to 0.80.9, where the
  supported synchronous stored-credential helper is available.

## [0.3.6] - 2026-07-04

### Fixed

- Bedrock (Anthropic/Claude) and Vertex AI (Gemini) foundation routes no
  longer emit empty or whitespace-only text blocks. Pi contexts legitimately
  contain them — errored assistant turns persist with `content: []`,
  thinking-only turns carry no text — and the old `{ text: " " }` placeholder
  was itself whitespace-only, so Anthropic rejected every subsequent request
  in the conversation with HTTP 400 "messages: text content blocks must
  contain non-whitespace text". Empty messages are now dropped (role
  coalescing re-merges the neighbours), empty text parts are filtered, and
  empty tool-result text gets a non-whitespace fallback.

### Added

- Added `scripts/test-empty-content-blocks.mjs`, a credential-free regression
  test covering both translators, and wired it into `npm test`.

## [0.3.5] - 2026-07-01

### Fixed

- Direct AWS Bedrock (Anthropic/Claude) foundation route now batches all
  corresponding `toolResult` blocks immediately after assistant `toolUse` blocks
  before appending screenshot/image content. This fixes Anthropic HTTP 400
  failures from Opus 4.8 such as "`tool_use` ids were found without
  `tool_result` blocks immediately after" on tool-heavy coding-agent turns.

### Added

- Added `scripts/test-bedrock-tool-results.mjs`, a credential-free regression
  test for Bedrock/Anthropic tool-result ordering, and wired it into `npm test`.

## [0.3.4] - 2026-07-01

### Fixed

- Direct GCP Vertex AI (Gemini) foundation route now sends pi tool schemas via
  Gemini's `parametersJsonSchema` (full JSON Schema) instead of the legacy
  `parameters` field (a restricted OpenAPI 3.0 subset). The legacy field rejected
  common JSON Schema constructs with HTTP 400 — `const` ("Unknown name const")
  and non-string `enum` values ("enum[0] (TYPE_STRING)") — which broke Gemini
  foundation models (e.g. `gemini-3.5-flash`) on tool-heavy coding-agent turns.
- SAP AI Core orchestration route no longer sends `reasoning_effort` alongside
  function tools for `gpt-*` models. SAP's `/v1/chat/completions` (the only
  endpoint reachable through the orchestration SDK) rejects that combination for
  gpt-5.x with a 400 pointing to `/v1/responses`, which is a foundation-models
  deployment endpoint the orchestration SDK cannot target. `reasoning_effort` is
  still sent on text-only turns; SAP continues to spend reasoning tokens
  internally on tool turns (governed by `max_completion_tokens`).

### Added

- Added `npm test` (`scripts/test-vertex-tool-schema.mjs`), a fast,
  credential-free regression test asserting the Vertex/Gemini adapter emits
  `parametersJsonSchema` and preserves `const`/boolean-`enum` constructs. Wired
  into `prepublishOnly`. The live `validate:foundation` matrix also gained a
  complex-tool-schema scenario that exercises the real HTTP tool path.

## [0.3.3] - 2026-07-01

### Added

- Added `npm run validate:foundation`, a live SAP AI Core validation matrix for
  direct foundation executables. It verifies text generation, real tool execution
  side effects, and image input across Azure OpenAI, AWS Bedrock, and GCP Vertex
  AI foundation routes.

### Changed

- Raised SAP AI SDK dependency floors to `^2.12.0` so fresh installs prefer the
  patched transitive `axios` / `form-data` tree that resolves the npm audit
  advisory for `form-data <4.0.6`.

## [0.3.2] - 2026-07-01

### Fixed

- Direct AWS Bedrock and GCP Vertex AI foundation routes now advertise pi tools
  using provider-native tool/function declaration schemas, so Claude and Gemini
  foundation models can perform real coding-agent tool calls instead of acting as
  text-only generators.
- Vertex/Gemini foundation tool-call replay now preserves Gemini thought signatures
  and normalizes provider-prefixed function names before emitting pi tool calls.

## [0.3.1] - 2026-07-01

### Added

- Direct foundation route support for Gemini models deployed through SAP AI Core
  `foundation-models` with the `gcp-vertexai` executable. The provider now calls
  SAP AI Core's Vertex-compatible `generateContent` endpoint and replays the
  non-streaming response into pi stream events.
- Vertex AI/Gemini message translation for text, images, assistant function-call
  history, and function-response history on the direct foundation route.

### Changed

- Gemini direct foundation requests set `generationConfig.thinkingConfig.thinkingBudget`
  to `0` by default so small pi output budgets produce visible text instead of
  being consumed entirely by hidden thoughts.
- Refreshed npm dependency lockfile after `npm update` to pick up patched SAP SDK
  transitive dependencies.

## [0.3.0] - 2026-07-01

### Added

- Direct foundation route support for Anthropic/Claude models deployed through SAP AI Core
  `foundation-models` with the `aws-bedrock` executable. The provider now calls SAP
  AI Core's Bedrock-compatible `/converse` endpoint and replays the non-streaming
  response into pi stream events.
- Foundation executable routing by model family: `gpt-*` uses `azure-openai`,
  `anthropic--*` uses `aws-bedrock`, and `gemini-*` is reserved for a future
  `gcp-vertexai` adapter.
- Bedrock Converse message translation for text, images, assistant tool-use history,
  and tool-result history on the direct foundation route.

### Changed

- Refactored the foundation provider into an executable dispatcher while preserving
  the existing Azure OpenAI streaming path for GPT models.
- Documentation now describes Azure OpenAI and AWS Bedrock direct foundation routes.

## [0.2.2] - 2026-06-16

### Fixed

- `/login → Use a subscription` no longer shows a duplicate `SAP AI Core`
  entry. The foundation provider now shares the orchestration provider's stored
  service key through the existing auth-store fallback instead of registering a
  second OAuth provider.

## [0.2.1] - 2026-06-10

### Fixed

- Foundation-provider tool-call history now preserves Azure/OpenAI's required
  ordering by emitting all matching `role: "tool"` replies immediately after an
  assistant `tool_calls` message, then hoisting screenshot/image outputs into
  synthetic user messages afterward.
- Streaming turns that contain tool calls are now finalized as `toolUse` even
  when SAP reports a trailing `stop`, preventing skipped tool execution and
  follow-up `invalid_request_error` failures about missing tool-call responses.

## [0.2.0] - 2026-06-06

### Added

- User-refreshable SAP model catalog cache at
  `~/.pi/agent/pi-sap-aicore/models-cache.json`.
- Per-machine SAP model overlay at `~/.pi/agent/pi-sap-aicore/models.json`, with
  support for `models`, `overrides`, `exclude`, and `foundation.enabledModelIds`.
- `/sap-models` command family:
  - `/sap-models update` refreshes public SAP model metadata without editing the
    installed npm package.
  - `/sap-models discover` compares the merged catalog against the SAP tenant's
    `foundation-models` scenario model list.
  - `/sap-models list`, `/sap-models paths`, and `/sap-models help` provide local
    catalog diagnostics.

### Changed

- Model registration now merges packaged snapshot, user cache, and user overlay
  at extension load time; `/sap-models update` re-registers providers in the
  current session after refreshing the cache.
- Foundation-route enablement is now configurable from the user overlay instead
  of requiring source edits.

## [0.1.2] - 2026-06-06

### Added

- Package-catalog preview image (`pi.image`) so the pi.dev gallery card shows a
  `pi --list-models` screenshot.
- Dependabot config: weekly grouped `npm` updates and `github-actions` updates.

### Changed

- CI: bump `actions/checkout` and `actions/setup-node` to v6 (off the deprecated
  Node 20 action runtime).

## [0.1.1] - 2026-06-06

### Added

- Continuous integration: `tsc --noEmit` verify gate on every push to `main` and
  every pull request.
- Release automation: tag-driven publish to npm via GitHub Actions using OIDC
  trusted publishing (tokenless, with provenance attestations).

### Changed

- Packaging: explicit `files` allowlist in `package.json` so the published tarball
  ships only runtime sources, helper scripts, and docs — CI/dev plumbing
  (`.github/`) no longer ships.

## [0.1.0] - 2026-06-06

### Added

- Initial public release on npm: `pi install npm:pi-sap-aicore`.
- **Orchestration provider** (`sap-aicore/*`) — Claude, GPT-5\*, and Gemini models
  through a single SAP AI Core orchestration deployment, with automatic
  non-streaming fallback when orchestration rejects streaming for a model.
- **Foundation provider** (`sap-aicore-foundation/*`) — direct Azure OpenAI
  deployments with native streaming, sharing the same login.
- Credential flow via pi's `/login` (oauth path, to survive the `$`-interpolating
  key resolver) and the `AICORE_SERVICE_KEY` environment override.
- Thinking-level mapping per model family (adaptive vs. budget-token Anthropic,
  `reasoning_effort` for OpenAI).
- MIT license and npm packaging.

[Unreleased]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ttiimmaahh/pi-sap-aicore/releases/tag/v0.1.0
