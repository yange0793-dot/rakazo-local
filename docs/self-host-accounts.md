# Local identity

This version runs as one local installation. Starting the API creates or reuses its local
owner and personal workspace. Opening the web or desktop app enters that workspace without
registration, a password, or an account session.

Set `API_HOST=127.0.0.1`. `WEB_ORIGIN` and `API_URL` name the local web and API listeners.
The API checks the request host, browser origin, and proxy headers before assigning the
local owner. A public hostname or forwarded remote request is refused.

The local owner can create organizations, spaces, bots, and connections. Selecting a space
uses `x-rakazo-space-id`; membership and resource checks still apply. An installation ID
identifies a device's notifications and caches, and is not a login credential.

Profile name changes, data export, and data import remain available in Settings. Exports use
short-lived local export grants. Model subscriptions, MCP connections, and website credentials
keep their own provider authorization flows.

The database upgrade removes the former account, password, session, passkey, directory,
verification, and login rate-limit tables, registration-policy columns, and login audit events.
It keeps users referenced by saved work, conversations, memories, bots, and provider credentials.
The removal migrations follow the repository's deferred-migration process.
