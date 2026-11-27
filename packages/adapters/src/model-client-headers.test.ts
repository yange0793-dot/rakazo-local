import { describe, expect, it } from "vitest";
import { modelClientHeaders, tagMixRouterRequest } from "./model-client-headers.js";

describe("model request source headers", () => {
  it.each(["http://127.0.0.1:8787/v1", "http://localhost:8787/v1", "http://[::1]:15721/v1"])(
    "marks loopback MixRouter endpoint %s",
    (baseUrl) => {
      expect(tagMixRouterRequest(modelClientHeaders("responses"), baseUrl)).toMatchObject({
        "x-rakazo-client": "rakazo",
      });
    },
  );

  it.each(["http://127.0.0.1:11434/v1", "https://api.example.test/v1"])(
    "does not mark other model endpoints %s",
    (baseUrl) => {
      expect(tagMixRouterRequest(modelClientHeaders("responses"), baseUrl)).not.toHaveProperty(
        "x-rakazo-client",
      );
    },
  );
});
