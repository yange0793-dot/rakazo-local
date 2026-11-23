import { LOCAL_INSTALL_SESSION_ID, LOCAL_INSTALL_SESSION_PREFIX } from "@rakazo/contracts";

const STORAGE_KEY = "rakazo:local-install-id";

export function localInstallSessionId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored?.startsWith(LOCAL_INSTALL_SESSION_PREFIX)) return stored;
    const id = `${LOCAL_INSTALL_SESSION_PREFIX}${globalThis.crypto.randomUUID()}`;
    window.localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return LOCAL_INSTALL_SESSION_ID;
  }
}
