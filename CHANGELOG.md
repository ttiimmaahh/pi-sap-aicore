# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The published package is now a bundle, `dist/index.js`, containing the SAP AI SDKs.
  SDK updates now arrive through releases of this package. `@sap/xssec` and
  `@sap/xsenv` stay out of the bundle because of their license and are installed
  from npm as dependencies.
- Git installs need a manual build step; see the README.
- Updated the SAP AI SDK packages to 2.17.0 and the development baseline to Pi 1.5.0,
  and refreshed locked dependencies to clear known advisories, including in code now
  shipped in the bundle (`axios`, `follow-redirects`, `node-forge` and `zod`).

### Fixed

- The extension now loads and serves requests on pi's standalone (Bun) binary, where
  it failed at startup with `Cannot find module 'fecha'`.
- GPT models now keep the selected reasoning effort on orchestration tool turns when
  SAP allows it. If SAP refuses the pair for a model, the turn is retried without
  the effort instead of failing.
- Thinking from an earlier model is now dropped after a model switch instead of being
  sent to the new model as visible text, matching Pi 1.3 and newer.

## [0.5.0] - 2026-10-15

### Changed

- Import every entry in models.dev's SAP AI Core catalog during runtime refreshes
  (`/sap-models update`) and maintainer snapshot refreshes, instead of limiting imports to
  Claude 4, GPT-5, and Gemini 2.5. Users choose models in `/model` or exclude
  unwanted entries through their overlay; foundation-route opt-in is unchanged.
- Refreshed the bundled snapshot from 16 to 55 model entries.
- Updated the development baseline to Pi 1.2.0 while retaining support for
  Pi 0.81.0 and newer. Adjusted tool argument types for Pi's JSON object contract.
  This supersedes the intermediate Pi 0.84.4 lockfile update in #23.
- Updated the locked SAP AI SDK packages to 2.16.0 (#25).

### Fixed

- Restored system prompts and tool declarations with Pi 0.87's normalized
  transcript context (#24). SAP AI Core requests previously received neither,
  causing models to narrate shell commands instead of emitting executable tool
  calls. Legacy Pi context fields remain supported.
- Preserved newline boundaries between system prompt text blocks in #24's
  transcript replay, with regression coverage before merging.
- Isolated standalone compatibility probes with `-ne -e` so the installed
  extension cannot override the working tree and hide failures. Model-count
  checks now match exact provider IDs rather than double-counting foundation
  models as orchestration models; full installed-extension startup remains tested.

### Added

- Offline regression tests for complete catalog imports in both refresh paths,
  and prompt/tool transcript replay across all four SAP translators, including
  compaction tool suppression and system updates during tool calls.
- Offline regression tests now run in CI alongside the typecheck; CI action
  revisions are pinned to immutable commits.

## [0.4.4] - 2026-08-27

### Fixed

- Excluded `scripts/debug-*.ts` from the published tarball. Local debugging
  scratch was being packed because `package.json` "files" whitelists `scripts`
  wholesale and a `.gitignore` rule does not override that; an explicit
  `"!scripts/debug-*.ts"` entry does. 13 stray files, now 0.
- Fixed the extension failing to load at pi startup with `Cannot find module
  '@earendil-works/pi-ai/api/transform-messages'`. 0.4.3 imported pi's shared
  `transformMessages()` helper straight from its module path. pi's extension
  loader maps only four pi-ai specifiers for extensions — `@earendil-works/pi-ai`
  (which resolves to the *compat* entrypoint) plus `/compat`, `/oauth` and
  `/providers/all` — and anything outside that map behaves differently per build:
  an npm-layout pi still has its dependencies on disk and resolves it by falling
  through to Node, a bundled pi has nothing to fall through to and fails. The
  helper is internal and re-exported from neither mapped root, so it is now
  vendored as `src/transform-messages.ts`, byte-for-byte equivalent to pi-ai
  0.81.1 through 0.84.3. The 0.4.3 tool-call pairing fix is unchanged in
  behaviour.

### Added

- `npm run test:startup` (also in `prepublishOnly`): boots the real pi with the
  full installed extension set — no `-e`, no `-ne` — against the working tree,
  which is temporarily swapped in as the live `npm:pi-sap-aicore` via
  `scripts/dev-link.mjs`. It probes with `pi -p` against a bogus provider, so pi
  loads every extension and stops before reaching a model: no network, no tokens,
  ~2s, and extension load failures surface verbatim. `--list-models` alone cannot
  do this — it swallows load errors and the provider just never registers — so
  both are asserted.
- `test:compat` is now `scripts/test-compat.mjs` instead of an inline
  `pi -e ./index.ts --list-models ...`, and it splits its assertions by what the
  machine can support. The extension-loads check is credential-free and runs
  everywhere, including the publish workflow; the model-listing check needs
  working SAP credentials and is skipped where there are none. The inline form
  checked only pi's exit code, and pi exits 0 while printing "No models
  available", so on a runner it asserted nothing at all. It also invoked bare
  `pi`, which fails whenever the PATH shim cannot run (e.g. mise pointing at a
  node version with no pi installed); `scripts/resolve-pi.mjs` now finds a pi
  that actually executes and reports whether it is a bundled or npm build.
- `test:startup` skips instead of failing where there is no local pi install to
  swap — a CI runner has no `~/.pi` at all. `test-compat.mjs` carries the
  credential-free load assertion for those environments.
- `npm run link:dev` / `unlink:dev` / `status:dev` for the same swap by hand, to
  run an interactive `pi` against the working tree. The published copy is renamed
  aside, never deleted, and `link` refuses to run over an existing backup.
- `scripts/test-transform-messages.mjs`, run first in `npm test`. It fails any
  value import of a pi specifier outside the loader's map — the class of bug
  above, which nothing else caught, because every other gate (`tsc --noEmit`,
  all of `npm test`, and `test:compat`) runs the extension from this repo, where
  pi-ai is a devDependency and therefore always resolves. The check is static on
  purpose: booting pi only reproduces the failure on a bundled build. The script
  also diffs the vendored `transformMessages()` against pi's real one over nine
  fixtures wherever pi-ai is resolvable, so upstream drift surfaces in CI rather
  than in a user's session.

## [0.4.3] - 2026-08-26

### Fixed

- Fixed conversations getting permanently stuck on `An assistant message with
  'tool_calls' must be followed by tool messages responding to each
  'tool_call_id'`. Both providers now run pi's shared `transformMessages()`
  helper over the conversation before translating it, the same way every
  built-in pi API adapter does. It drops errored/aborted assistant turns —
  a turn killed mid-stream by an SSE drop or an interrupt is persisted by pi
  with the tool calls it had emitted and no results, and replaying it failed
  *every* subsequent request in that session with the same ids — and it
  synthesises results for tool calls orphaned any other way. It also downgrades
  images for text-only models and normalises thinking blocks across a
  mid-conversation model switch.
- Fixed the orchestration translator splitting the tool-message block. A tool
  result carrying an image is hoisted into a synthetic user message (SAP's
  tool-message content schema is text-only), which produced
  `tool, user(image), tool` and made the backend reject every tool_call_id past
  the first. Tool results are now batched into one contiguous block in
  `tool_calls` order, with hoisted images following it. The foundation
  (Azure OpenAI) translator already did this; the orchestration path never got
  the same fix.
- An aborted stream is no longer reported to pi as a completed turn. The
  orchestration and foundation Azure OpenAI streaming loops broke out of the
  chunk loop on abort and then emitted `done`, persisting a half-built tool call
  as a successful `toolUse` turn; they now mark the turn `aborted`, matching
  pi's own adapters.
- A tool call whose argument JSON never finished streaming — the model hit its
  output cap mid-call, or the connection dropped — no longer executes with `{}`.
  The parse failure was swallowed, so the tool ran with no arguments and no
  error. Both OpenAI-shaped paths now use pi's tolerant `parseStreamingJson`,
  which recovers the fields the model did emit; it also keeps `arguments` in step
  with the stream, so pi renders a tool call's arguments as they arrive instead
  of showing `{}` until the last fragment.
- A streamed tool call that never received an id is now given one instead of
  being sent with an empty `tool_call_id`, which failed the same way an
  unanswered call did. The Bedrock path already did this.

### Added

- Added support for pi 0.84.3's `toolChoice` stream option. pi sets
  `toolChoice: "none"` on its summarization/compaction turns; the extension
  ignored it, so the model could answer a compaction request with tool calls —
  which have no results and then break every following request. All four routes
  now send no tools for `"none"`. That is the one encoding every backend here
  understands: SAP documents orchestration's `tool_choice` only as an
  unvalidated passthrough, and Bedrock's Converse `toolChoice` has no `"none"`
  member. `"auto"` is every backend's default and needs no encoding.
- Added a preflight check on both OpenAI-shaped request builders: an assistant
  `tool_calls` message with an unanswered id now fails locally, naming the ids
  and where the pairing broke, instead of spending a round trip to come back as
  an opaque SAP 400. The message is worded so pi classifies it non-retryable —
  a translation bug cannot succeed on a retry.
- Added a Troubleshooting section to the README covering
  `PI_SAP_AICORE_DEBUG_PAYLOAD` request capture (previously undocumented), the
  tool_call_id error above, streaming-unsupported models, and the full
  environment-variable reference.

### Changed

- Validated against pi 0.84.3 and moved the development/CI baseline to it. The
  minimum supported pi version remains 0.81.0: `toolChoice` is simply absent on
  older pi versions, and the extension behaves exactly as before when it is.

## [0.4.2] - 2026-08-18

### Changed

- Validated the native Provider implementation against pi 0.84.2 and updated the
  development/CI baseline for `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` to 0.84.2. The minimum supported Pi version
  remains 0.81.0.
- Added a package-load/model-list compatibility smoke test and included it in the
  prepublish verification gate.

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

[Unreleased]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.4.1...v0.4.2
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
