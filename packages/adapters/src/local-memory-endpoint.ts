import { isIP } from "node:net";

/** Exact endpoints authorized for the managed local memory index, not MCP egress. */
export const LOCAL_MEMORY_ALLOWED_URLS_ENV = "RAKAZO_LOCAL_MEMORY_ALLOWED_URLS";

/** No DNS, route prefixes, credentials or redirect state enter this boundary. */
export function normalizeLocalMemoryBaseUrl(baseUrl: string): string {
  const input = baseUrl.trim();
  const url = new URL(input);
  const authority = /^https?:\/\/([0-9.]+|\[[0-9a-fA-F:]+\])(?::[0-9]+)?\/?$/.exec(input);
  const literal = authority?.[1]?.replace(/^\[|\]$/g, "") ?? "";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (
    !authority ||
    isIP(literal) === 0 ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Local memory baseUrl must be a loopback IP HTTP(S) origin.");
  }
  return url.origin;
}

export function localMemoryEndpointAllowed(
  baseUrl: string,
  allowedUrls: string | undefined = process.env[LOCAL_MEMORY_ALLOWED_URLS_ENV],
): boolean {
  const endpoint = normalizeLocalMemoryBaseUrl(baseUrl);
  return (allowedUrls ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => normalizeLocalMemoryBaseUrl(entry) === endpoint);
}

/** Also used at request time, so revoking the operator policy stops existing clients. */
export function assertLocalMemoryEndpointAllowed(baseUrl: string, allowedUrls?: string): string {
  const normalized = normalizeLocalMemoryBaseUrl(baseUrl);
  if (!localMemoryEndpointAllowed(normalized, allowedUrls)) {
    throw new Error("Local memory endpoint requires an exact operator allowlist entry.");
  }
  return normalized;
}
