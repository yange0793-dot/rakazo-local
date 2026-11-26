# Rakazo Local Version

This repository contains the complete application source snapshot of the local version as of November 26, 2026. It builds on [Rakazo](https://github.com/elie222/rakazo); the upstream license and attribution remain in place.

## Local Development

- Shared model and provider settings across web, desktop, and mobile, including six reasoning levels and three approval modes.
- Persistent task coordination, external execution receipts, delivery checks, and managed work.
- Automatic memory extraction, semantic recall, task reflection, and provenance-aware deletion.
- Native Codex and Claude Code execution adapters, plus a local MCP service for managing their sessions.
- macOS service management, backup, rollback, health checks, and optional phone access.

These are implementation areas represented in the source and tests. They are not a claim of general autonomous self-improvement or of validation on every deployment.

## Source Layout

The application remains in `apps/`, shared behavior in `packages/`, and infrastructure in `infra/` and `scripts/`. Dependencies are pinned by `pnpm-lock.yaml`.

`local-native/` contains the native service scripts, desktop build configuration, agent communication service, and phone gateway. Its README describes the environment it expects.

For a standard source deployment, begin with the [self-hosting guide](docs/zh-CN/self-host.md). The native scripts are an additional macOS deployment option.

## Verification Scope

The publication preserves the source tests. Publication checks cover source completeness, generated-file exclusions, secret-scan findings, native script syntax, and focused tests for the portable native helpers. A new full application regression or deployment is not implied by this snapshot.
