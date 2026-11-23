# Local production deployment

Rakazo uses one local installation owner. Open the app directly; registration,
passwords, passkeys, and directory provisioning are no longer part of the product.
See [Local installation identity](./self-host-accounts.md).

## Runtime

Run the API and worker as persistent processes with the Node.js version specified
in the root `package.json`, PostgreSQL 16 or newer, and a shared persistent
`DATA_DIR`. The web host serves the app and proxies `/api` and `/rpc` to the API.

Keep both listeners on loopback:

```env
NODE_ENV=production
API_HOST=127.0.0.1
API_URL=http://127.0.0.1:3100
WEB_ORIGIN=http://127.0.0.1:5173
RAKAZO_WEB_BIND=127.0.0.1
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
```

Use separate database owner and runtime credentials as described in
[configuration](./self-host-configuration.md#database-roles). Configure independent
`ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, and, when using Docker computers,
`SANDBOX_SUPERVISOR_TOKEN` values. Model and computer providers remain optional
until their functionality is used.

The API and web host reject remote application traffic. Public multi-user
deployment instructions and registration allowlists do not apply to this version.
Changing a public origin does not enable remote access.

## Updates and data

Build the API, worker, and web app before replacing the running release. Apply
migrations with `pnpm db:migrate`, retain the previous build until the new services
are healthy, and verify the API's `/ready` endpoint and worker heartbeat.
Migrations marked `-- deferred` are held for one deployment so a previous process
can finish before obsolete tables or columns are removed.

Keep the database, `DATA_DIR`, and encryption keys in the installation's backup.
The in-app data export uses a short-lived, single-use download token.
Removing old login tables does not remove conversations, spaces, files, model
connections, or provider OAuth credentials.

The optional marketing site in `apps/www` can be hosted separately.
