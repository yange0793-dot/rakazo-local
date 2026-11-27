import type { ProviderHeaders } from "@earendil-works/pi-ai";

const MIXROUTER_LOOPBACK_PORTS = new Set(["8787", "15721"]);

export const CODEX_CLIENT_HEADERS = {
  "user-agent": "codex_cli_rs/0.154.0 (external, cli)",
  originator: "codex_cli_rs",
};

/** Protocol client identities shared by runtime calls and connection probes. */
export function modelClientHeaders(
  api: string | undefined,
  ...overrides: Array<ProviderHeaders | undefined>
): ProviderHeaders {
  const headers: ProviderHeaders =
    api === "anthropic-messages"
      ? { "user-agent": "claude-cli/2.1.219 (external, cli)", "x-app": "cli" }
      : api === undefined ||
          api === "responses" ||
          api === "chat-completions" ||
          api.startsWith("openai-")
        ? { ...CODEX_CLIENT_HEADERS }
        : {};
  for (const override of overrides) {
    for (const [name, value] of Object.entries(override ?? {})) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

/** Distinguish Rakazo model calls from native clients when they pass through local MixRouter. */
export function tagMixRouterRequest(
  headers: ProviderHeaders,
  baseUrl: string | undefined,
): ProviderHeaders {
  if (!baseUrl) return headers;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return headers;
  }
  if (
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    MIXROUTER_LOOPBACK_PORTS.has(url.port)
  ) {
    headers["x-rakazo-client"] = "rakazo";
  }
  return headers;
}
