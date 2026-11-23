import { isLocalhostOrLoopbackIp, isLoopbackAddress } from "./network-host.js";

export const LOCAL_INSTALL_SESSION_PREFIX = "rakazo-local-install:";
export const LOCAL_INSTALL_SESSION_ID = `${LOCAL_INSTALL_SESSION_PREFIX}default`;

export function isLocalInstallSessionId(value: string): boolean {
  return (
    value.startsWith(LOCAL_INSTALL_SESSION_PREFIX) &&
    /^[a-zA-Z0-9-]{1,100}$/.test(value.slice(LOCAL_INSTALL_SESSION_PREFIX.length))
  );
}

/** Run before a web proxy rewrites Host or an API route assigns the local owner. */
export function localRequestAllowed(
  host: string,
  header: (name: string) => string | undefined,
): boolean {
  const authority = /^(\[[\da-f:]+\]|[a-z\d.-]+)(?::\d+)?$/i.exec(host)?.[1];
  if (!authority || !isLocalhostOrLoopbackIp(authority)) return false;
  if (header("forwarded") || header("x-forwarded-host") || header("x-real-ip")) return false;
  const chain = header("x-forwarded-for");
  return !chain || chain.split(",").every((ip) => isLoopbackAddress(ip.trim()));
}
