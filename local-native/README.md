# Native Runtime Sources

This directory contains the macOS runtime helpers used with the local Rakazo version. Place it inside the application checkout, or set `RAKAZO_SRC` to the checkout's absolute path.

## Services

- `pg-setup.sh`: initialize and manage a PostgreSQL 16 cluster. Supply PostgreSQL binaries under `postgres/bin/`.
- `start-native.sh`, `stop-native.sh`, `verify-native.sh`: service lifecycle and installation checks.
- `deploy-stack.cjs`: staged builds, migrations, verification, and rollback.
- `backup.sh`, `rotate-logs.sh`, `watchdog.sh`: optional maintenance jobs.
- `memory-service.sh`: local semantic-memory service. Its Python runtime belongs under `memory-runtime/python/`.
- `desktop-build.cjs`: optional Electron packaging configuration.
- `runtime/agent-phone/`: local MCP and HTTP bridge to native `codex` and `claude` executables on `PATH`.
- `runtime/phone-access/`: optional authenticated phone gateway and fixed-domain tunnel.

## Configuration

Create a private `env.native` using the variables documented in the application's `.env.example` and self-hosting guide. The native PostgreSQL helper generates `env.postgres`; keep database URLs and role passwords consistent with it. The native database port is `55432`.

Install application dependencies from the repository root with `pnpm install --frozen-lockfile`. Each runtime subdirectory with a `package-lock.json` uses `npm ci`. Configure the optional runtimes using their local `config.json` files and documentation.

Optional LaunchAgent labels use `ai.rakazo.native`, `ai.rakazo.memory`, `ai.rakazo.watchdog`, `ai.rakazo.backup`, and `ai.rakazo.logrotate`. Create jobs for the installation paths on your own machine.

The repository contains source and dependency manifests. Installation-specific credentials, databases, conversations, downloaded runtimes, and generated builds stay in the installation.
