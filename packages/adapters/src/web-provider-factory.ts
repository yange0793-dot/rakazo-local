import type { WebProvider } from "@rakazo/adapter-kit";
import { FakeWebProvider } from "./fake-web.js";
import { KeenableWebProvider } from "./keenable-web.js";
import { KeylessHttpWebProvider } from "./keyless-http-web.js";
import { ParallelWebProvider } from "./parallel-web.js";
import { TinyFishWebProvider } from "./tinyfish-web.js";

export function resolveWebProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.WEB_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "tinyfish") return "tinyfish";
  if (raw === "fake") return "fake";
  return raw;
}

export function createWebProvider(
  kind: string = resolveWebProviderKind(),
  options?: ConstructorParameters<typeof TinyFishWebProvider>[0],
): WebProvider {
  switch (kind) {
    case "tinyfish":
      return new TinyFishWebProvider(options);
    case "parallel":
      return new ParallelWebProvider(options);
    case "keenable":
      return new KeenableWebProvider(options);
    case "fake":
      return new FakeWebProvider();
    case "keyless-http":
    case "keyless":
      return new KeylessHttpWebProvider(options);
    default:
      throw new Error(`Unknown web provider "${kind}"`);
  }
}
