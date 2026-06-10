# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ttiimmaahh/pi-sap-aicore/releases/tag/v0.1.0
