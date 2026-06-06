# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Continuous integration: `tsc --noEmit` verify gate on every push to `main` and
  every pull request.
- Release automation: tag-driven publish to npm via GitHub Actions using OIDC
  trusted publishing (tokenless, with provenance attestations).

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

[Unreleased]: https://github.com/ttiimmaahh/pi-sap-aicore/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ttiimmaahh/pi-sap-aicore/releases/tag/v0.1.0
