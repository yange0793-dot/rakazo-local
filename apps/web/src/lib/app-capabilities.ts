import { readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";

const appCapabilitiesSchema = z.object({
  billing: z.boolean(),
  crispWebsiteId: z.string().min(1).nullable(),
});

export type AppCapabilities = z.infer<typeof appCapabilitiesSchema>;

let capabilitiesRequest: Promise<AppCapabilities> | undefined;

export function fetchAppCapabilities(): Promise<AppCapabilities> {
  capabilitiesRequest ??= loadAppCapabilities().catch((error: unknown) => {
    capabilitiesRequest = undefined;
    throw error;
  });
  return capabilitiesRequest;
}

async function loadAppCapabilities(): Promise<AppCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("/api/app-capabilities", { signal: controller.signal });
    if (!response.ok) throw new Error("Could not load app capabilities");
    return appCapabilitiesSchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } finally {
    clearTimeout(timer);
  }
}
