import type { ModelCredential } from "@rakazo/contracts";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionFormDraft } from "./model-connection-form.js";
import {
  compatibleConnectionReady,
  connectionFormFields,
  connectionFormModelId,
  modelConnectRequest,
} from "./model-connection-form.js";

const catalog = [
  {
    provider: "anthropic",
    id: "opus",
    reasoning: true,
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  },
  { provider: "anthropic", id: "sonnet", recommended: true },
  { provider: "openrouter", id: "jev" },
];
const COMPATIBLE = "openai-compatible";

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-fixture",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
    ...overrides,
  };
}

function draft(overrides: Partial<ConnectionFormDraft> = {}): ConnectionFormDraft {
  return {
    apiKey: "",
    modelId: "",
    enabledModelIds: [],
    baseUrl: "",
    apiProtocol: "chat-completions",
    headerRows: null,
    reasoning: false,
    thinkingLevel: null,
    maxTokens: "",
    contextWindow: "262144",
    supportsImages: false,
    maxImagesPerPrompt: "",
    accountId: "",
    gatewayId: "",
    ...overrides,
  };
}

describe("connectionFormModelId", () => {
  it("keeps the model on screen while the catalog lists it", () => {
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        current: "opus",
      }),
    ).toBe("opus");
  });

  it("falls back to the connection's model, then the default, then the recommended one", () => {
    const defaults = { defaultProvider: "anthropic", defaultModel: "opus" };
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        defaults,
        current: "gone",
      }),
    ).toBe("sonnet");
    expect(connectionFormModelId({ catalog, provider: "anthropic", defaults })).toBe("opus");
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        defaults: { defaultProvider: "openrouter", defaultModel: "jev" },
      }),
    ).toBe("sonnet");
  });

  it("opens a new OpenAI-compatible connection empty instead of on another server's model", () => {
    const defaults = { defaultProvider: COMPATIBLE, defaultModel: "local-model" };
    expect(connectionFormModelId({ catalog, provider: COMPATIBLE, defaults })).toBe("");
    expect(
      connectionFormModelId({
        catalog,
        provider: COMPATIBLE,
        credential: credential({ provider: COMPATIBLE, modelId: "saved-model" }),
        defaults,
        current: "typed-model",
      }),
    ).toBe("saved-model");
  });
});

describe("connectionFormFields", () => {
  it("fills a new connection with defaults and the endpoint preset", () => {
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "",
        presetBaseUrl: "https://ollama.com/v1",
      }),
    ).toEqual({
      enabledModelIds: [],
      baseUrl: "https://ollama.com/v1",
      apiProtocol: "chat-completions",
      reasoning: false,
      thinkingLevel: null,
      maxTokens: "",
      contextWindow: "262144",
      supportsImages: false,
      maxImagesPerPrompt: "",
      accountId: "",
      gatewayId: "",
    });
  });

  it("shows a saved OpenAI-compatible connection, with effort only for its saved model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      enabledModelIds: ["local", "other"],
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: 2048,
      contextWindow: 32_000,
      supportsImages: true,
      maxImagesPerPrompt: 4,
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "local",
      credential: saved,
      presetBaseUrl: "https://ignored.example/v1",
    });
    expect(fields).toMatchObject({
      enabledModelIds: ["local", "other"],
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "chat-completions",
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: "2048",
      contextWindow: "32000",
      supportsImages: true,
      maxImagesPerPrompt: "4",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "other", credential: saved })
        .thinkingLevel,
    ).toBeNull();
  });

  it("keeps the shared effort selection when a protocol maps it to a lower wire level", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      reasoning: true,
      thinkingLevel: "max",
      apiProtocol: "anthropic-messages",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .apiProtocol,
    ).toBe("anthropic-messages");
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .thinkingLevel,
    ).toBe("max");
    const request = modelConnectRequest({
      form: draft({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "local",
        apiProtocol: "anthropic-messages",
        reasoning: true,
        thinkingLevel: "xhigh",
        maxTokens: "4096",
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "xhigh",
    });
  });

  it("keeps an explicit adaptive declaration when opening and saving its connection", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://localhost:8000/v1",
      apiProtocol: "anthropic-messages",
      modelId: "fixture",
      reasoning: true,
      thinkingLevel: "max",
      reasoningCapabilities: { mode: "adaptive", levels: ["off", "high", "max"] },
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "fixture",
      credential: saved,
    });
    expect(fields.thinkingLevel).toBe("max");
    const form = { ...draft(), ...fields, modelId: "fixture" };
    const request = modelConnectRequest({
      form,
      selected: { provider: COMPATIBLE, id: "custom" },
      credential: saved,
      credentialId: saved.id,
    });
    expect(request.status === "ready" && request.input.thinkingLevel).toBe("max");
    const changedEndpoint = modelConnectRequest({
      form: { ...form, baseUrl: "http://localhost:8001/v1" },
      selected: { provider: COMPATIBLE, id: "custom" },
      credential: saved,
      credentialId: saved.id,
    });
    expect(changedEndpoint.status === "ready" && changedEndpoint.input.thinkingLevel).toBe("max");
  });

  it("keeps the shared effort selection for a catalog model and leaves the endpoint empty", () => {
    const fields = connectionFormFields({
      catalog,
      provider: "anthropic",
      modelId: "opus",
      credential: credential({ modelId: "opus", thinkingLevel: "medium", baseUrl: "x" }),
    });
    expect(fields.thinkingLevel).toBe("medium");
    expect(fields.baseUrl).toBe("");
    expect(fields.maxTokens).toBe("");
  });
});

describe("compatibleConnectionReady", () => {
  const ready = { apiKey: "", baseUrl: " http://h/v1 ", modelId: "m", headerRows: null };

  it("needs a URL and a model", () => {
    expect(compatibleConnectionReady(ready)).toBe(true);
    expect(compatibleConnectionReady({ ...ready, modelId: "" })).toBe(false);
    expect(compatibleConnectionReady({ ...ready, baseUrl: " " })).toBe(false);
  });

  it("refuses invalid header rows", () => {
    expect(
      compatibleConnectionReady({ ...ready, headerRows: [{ name: "bad name", value: "v" }] }),
    ).toBe(false);
  });
});

describe("modelConnectRequest", () => {
  const anthropic = {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    reasoning: true,
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  };

  it("waits for a key, or a saved connection for a limits-only save", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "short" }),
        selected: anthropic,
        credentialId: null,
      }).status,
    ).toBe("incomplete");
    expect(
      modelConnectRequest({ form: draft(), selected: anthropic, credentialId: null }).status,
    ).toBe("incomplete");
  });

  it("names the out-of-range field", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "sk-long-enough", maxTokens: "0" }),
        selected: anthropic,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxTokens" });
    const compatible = { provider: COMPATIBLE, id: "openai-compatible" };
    const form = draft({ baseUrl: "http://h/v1", modelId: "m", maxTokens: "4096" });
    expect(
      modelConnectRequest({
        form: { ...form, supportsImages: true, maxImagesPerPrompt: "2000" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxImagesPerPrompt" });
    expect(
      modelConnectRequest({
        form: { ...form, contextWindow: "" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
  });

  it.each(["", "  "])(
    "saves a compatible connection with an empty output limit (%j)",
    (maxTokens) => {
      const request = modelConnectRequest({
        form: draft({ baseUrl: "http://localhost:8000/v1", modelId: "fixture", maxTokens }),
        selected: { provider: COMPATIBLE, id: "custom" },
        credentialId: null,
      });
      expect(request.status).toBe("ready");
      if (request.status !== "ready") throw new Error("Expected a ready connection");
      expect(request.input.maxTokens).toBeNull();
      expect(ModelConnectInputSchema.safeParse(request.input).success).toBe(true);
    },
  );

  it("explicitly clears a saved compatible output limit instead of preserving it by omission", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://localhost:8000/v1",
      modelId: "fixture",
      maxTokens: 8192,
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "fixture",
      credential: saved,
    });
    expect(fields.maxTokens).toBe("8192");
    const request = modelConnectRequest({
      form: { ...draft(), ...fields, modelId: "fixture", maxTokens: "" },
      selected: { provider: COMPATIBLE, id: "custom" },
      credential: saved,
      credentialId: saved.id,
    });
    expect(request.status === "ready" && request.input.maxTokens).toBeNull();
    expect(saved.maxTokens).toBe(8192);
  });

  it.each(["0", "-1", "1.5", "bad"])(
    "still rejects a nonblank invalid compatible limit: %s",
    (maxTokens) => {
      expect(
        modelConnectRequest({
          form: draft({ baseUrl: "http://localhost:8000/v1", modelId: "fixture", maxTokens }),
          selected: { provider: COMPATIBLE, id: "custom" },
          credentialId: null,
        }),
      ).toEqual({ status: "invalid", field: "maxTokens" });
    },
  );

  it("connects a catalog key with the shared effort and the makeDefault target", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: " sk-long-enough ", thinkingLevel: "medium" }),
        selected: anthropic,
        credentialId: null,
        makeDefault: { makeDefault: true, scope: "account" },
      }),
    ).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "opus",
      input: {
        provider: "anthropic",
        apiKey: "sk-long-enough",
        modelId: "opus",
        thinkingLevel: "medium",
        makeDefault: true,
        scope: "account",
        maxTokens: null,
        label: "Anthropic",
        credentialId: null,
      },
    });
  });

  it("leaves the stored effort alone on a limits-only save unless model or effort changed", () => {
    const saved = credential({ modelId: "opus", thinkingLevel: "high" });
    const limits = modelConnectRequest({
      form: draft({ apiKey: "sk-ignored-here", maxTokens: "1024", thinkingLevel: "high" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      settingsOnly: true,
    });
    expect(limits).toMatchObject({ status: "ready", savingLimitOnly: true });
    expect(limits.status === "ready" && limits.input).toEqual({
      provider: "anthropic",
      modelId: "opus",
      maxTokens: 1024,
      label: "Anthropic",
      credentialId: saved.id,
    });
    const effort = modelConnectRequest({
      form: draft({ thinkingLevel: "low" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
    });
    expect(effort.status === "ready" && effort.input.thinkingLevel).toBe("low");
    const model = modelConnectRequest({
      form: draft(),
      selected: anthropic,
      credential: credential({ modelId: "sonnet" }),
      credentialId: saved.id,
    });
    expect(model.status === "ready" && "thinkingLevel" in model.input).toBe(true);
  });

  it("sends routing ids trimmed when the provider asks for them", () => {
    const request = modelConnectRequest({
      form: draft({ apiKey: "cf-long-enough", accountId: " acct ", gatewayId: " gw " }),
      selected: {
        provider: "example-gateway",
        id: "model",
        routingFields: ["accountId", "gatewayId"],
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      accountId: "acct",
      gatewayId: "gw",
    });
  });

  it("saves an OpenAI-compatible connection without repeating its default in the enabled list", () => {
    const request = modelConnectRequest({
      form: draft({
        apiKey: " key ",
        baseUrl: " http://h/v1 ",
        modelId: " m ",
        enabledModelIds: ["m", "n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: "4096",
        supportsImages: true,
        headerRows: [{ name: " X-Team ", value: "v" }],
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: "credential-fixture",
    });
    expect(request).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "m",
      input: {
        provider: COMPATIBLE,
        baseUrl: "http://h/v1",
        apiProtocol: "chat-completions",
        headers: { "X-Team": "v" },
        modelId: "m",
        enabledModelIds: ["n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 4096,
        contextWindow: 262_144,
        supportsImages: true,
        maxImagesPerPrompt: null,
        apiKey: "key",
        label: "OpenAI-compatible",
        credentialId: "credential-fixture",
      },
    });
  });
});
