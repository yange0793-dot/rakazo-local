import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import type { EgoBrowserProviderOptions } from "./ego-browser.js";
import { EgoBrowserProvider } from "./ego-browser.js";
import type { FakeBrowserProviderOptions } from "./fake-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";

export type CreateBrowserProviderOptions = FakeBrowserProviderOptions & {
  sandbox?: SandboxProvider;
  /** Settings for the opt-in ego page browser, used only for BROWSER_PROVIDER=ego. */
  ego?: EgoBrowserProviderOptions;
};

/**
 * Production default is always `computer` (live CDP on the bot computer). Fake and emulator
 * are selected only by BROWSER_PROVIDER=fake or emulator, for offline conformance. Ego is the
 * installed ego lite page browser, selected explicitly by BROWSER_PROVIDER=ego.
 */
export function resolveBrowserProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.BROWSER_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "computer" || raw === "sandbox") return "computer";
  if (raw === "fake") return "fake";
  if (raw === "emulator") return "emulator";
  if (raw === "ego") return "ego";
  return raw;
}

export function createBrowserProvider(
  kind?: string,
  options?: CreateBrowserProviderOptions,
): BrowserProvider {
  const resolved = (kind ?? resolveBrowserProviderKind()).trim() || resolveBrowserProviderKind();
  switch (resolved) {
    case "computer":
    case "sandbox":
    case "":
      return new ComputerBrowserProvider(options);
    case "fake":
      return new FakeBrowserProvider(options);
    case "emulator":
      return new EmulatorBrowserProvider(options);
    case "ego":
      // The provider itself defaults its blocked origins to the app's own origins from
      // WEB_ORIGIN, BETTER_AUTH_URL and RAKAZO_EXTRA_AUTH_ORIGINS when none are passed.
      return new EgoBrowserProvider(options?.ego ?? {});
    default:
      throw new Error(`Unknown browser provider "${resolved}"`);
  }
}
