import type {
  ModelCatalogEntry,
  ModelCredential,
  ModelRole,
  ModelRoleChoice,
  ModelRoleSettings,
  ModelRoleView,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  connectedBackupOptions,
  connectionDisplayName,
  modelRoleChoiceKey,
} from "@rakazo/contracts";
import { credentialForModel } from "./model-providers.js";

/** Choices, including the connection an older, unpinned role row already uses. */
export function modelRolePickerData(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
  role: ModelRole,
  displayProvider?: (provider: string, name: string, auth?: string) => string,
) {
  const byId = new Map(credentials.map((connection) => [connection.id, connection]));
  const connectionFor = (choice: ModelRoleChoice) =>
    choice.credentialId
      ? byId.get(choice.credentialId)
      : (credentialForModel(credentials, choice.provider, choice.modelId) ??
        credentials.find(
          (entry) =>
            entry.provider === choice.provider &&
            entry.catalogSource?.unavailableModelIds.includes(choice.modelId),
        ) ??
        credentials.find(
          (entry) =>
            canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
            !entry.catalogSource,
        ));
  const keyFor = (choice: ModelRoleChoice) =>
    modelRoleChoiceKey(
      choice.credentialId ? choice : { ...choice, credentialId: connectionFor(choice)?.id },
    );
  const unavailable = (choice: ModelRoleChoice) => {
    const connection = connectionFor(choice);
    if (choice.credentialId && !connection) return true;
    if (connection?.reconnectRequired) return true;
    const source = connection?.catalogSource;
    return Boolean(
      source && (!source.available || source.unavailableModelIds.includes(choice.modelId)),
    );
  };
  const entryFor = (choice: ModelRoleChoice) =>
    catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
        entry.id === choice.modelId &&
        (!choice.credentialId ||
          !entry.credentialIds ||
          entry.credentialIds.includes(choice.credentialId)),
    );

  const byName = new Map<string, ModelCredential[]>();
  for (const credential of credentials) {
    const provider = canonicalPiProviderId(credential.provider);
    const catalogName =
      catalog.find((entry) => canonicalPiProviderId(entry.provider) === provider)?.providerName ??
      credential.provider;
    const name = credential.catalogSource
      ? credential.label
      : connectionDisplayName(
          credential,
          displayProvider?.(credential.provider, catalogName, credential.authKind) ?? catalogName,
          [catalogName],
        );
    const peers = byName.get(name);
    if (peers) peers.push(credential);
    else byName.set(name, [credential]);
  }
  const names = new Map<string, string>();
  for (const [name, peers] of byName) {
    for (const peer of peers) {
      const group = peer.catalogSource?.group;
      const qualifier =
        group && peers.filter((other) => other.catalogSource?.group === group).length === 1
          ? group
          : peer.id;
      names.set(peer.id, peers.length === 1 ? name : `${name} (${qualifier})`);
    }
  }
  const connectionName = (choice: ModelRoleChoice) => {
    const id = choice.credentialId ?? connectionFor(choice)?.id;
    return id ? names.get(id) : undefined;
  };
  const options = connectedBackupOptions(catalog, credentials, role === "computer")
    .filter((option) => !unavailable(option))
    .map((option) => ({
      ...option,
      connectionName: connectionName(option) ?? option.connectionName,
    }));
  return { options, entryFor, connectionFor, connectionName, keyFor, unavailable };
}

export interface ModelRoleTransport {
  load(): Promise<ModelRoleView>;
  catalog(): Promise<ModelCatalogEntry[]>;
  save(patch: Partial<ModelRoleSettings>): Promise<ModelRoleView>;
}
export type ModelRoleState = {
  settings: ModelRoleView | null;
  catalog: ModelCatalogEntry[];
  busy: boolean;
  /** The last load failed, so the shown settings may be outdated and cannot be edited. */
  stale: boolean;
  error: string | null;
};

type SaveQueue = { tail: Promise<void>; failures: number };
const pendingWrites = new Map<string, SaveQueue>();

/**
 * Shared web/native lifecycle. Writes finish in their original scope; stale loads cannot win.
 * `initial` is what this scope showed last time, shown while the first load refreshes it.
 */
export function createModelRoleSettings(
  transport: ModelRoleTransport,
  scopeKey: string,
  initial?: { settings: ModelRoleView; catalog: ModelCatalogEntry[] },
) {
  let state: ModelRoleState = {
    settings: initial?.settings ?? null,
    catalog: initial?.catalog ?? [],
    busy: !initial,
    stale: false,
    error: null,
  };
  let generation = 0;
  let confirmed: ModelRoleView | null = initial?.settings ?? null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ModelRoleState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  async function fetchSettings(current: number) {
    try {
      await pendingWrites.get(scopeKey)?.tail;
      const [settings, catalog] = await Promise.all([transport.load(), transport.catalog()]);
      if (current === generation) {
        confirmed = settings;
        publish({ settings, catalog, busy: false, stale: false });
      }
    } catch (error) {
      if (current === generation)
        publish({
          busy: false,
          stale: true,
          error: error instanceof Error ? error.message : "Could not load models",
        });
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    load() {
      const current = ++generation;
      publish({ busy: true, error: null });
      loading = fetchSettings(current);
      return loading;
    },
    /** A function patch reads the settings as they are once any in-flight load settles. */
    async save(
      update:
        | Partial<ModelRoleSettings>
        | ((settings: ModelRoleSettings) => Partial<ModelRoleSettings>),
    ) {
      while (state.busy && loading) {
        const settled = loading;
        await settled;
        if (loading === settled) break;
      }
      if (state.busy || state.stale || !state.settings) return;
      const patch = typeof update === "function" ? update(state.settings) : update;
      const current = generation;
      publish({ settings: { ...state.settings, ...patch }, error: null });
      const queue = pendingWrites.get(scopeKey) ?? { tail: Promise.resolve(), failures: 0 };
      const failures = queue.failures;
      const write = queue.tail.then(async () => {
        if (failures !== queue.failures) return;
        try {
          confirmed = await transport.save(patch);
          if (current === generation && queue.tail === write) {
            publish({ settings: confirmed });
          }
        } catch (error) {
          queue.failures += 1;
          if (current === generation)
            publish({
              settings: confirmed,
              error: error instanceof Error ? error.message : "Could not save models",
            });
        }
      });
      queue.tail = write;
      pendingWrites.set(scopeKey, queue);
      await write;
      if (queue.tail === write) pendingWrites.delete(scopeKey);
    },
  };
}

/**
 * The save for a purpose's reordered list, whose first row runs. With a primary set, the
 * primary is sent only when it changes, so editing fallbacks never rewrites the main model.
 */
export function modelRoleListPatch(
  current: ModelRoleSettings,
  list: ModelRoleChoice[],
): Partial<ModelRoleSettings> {
  if (!current.primary) return { backups: list };
  const primary = list[0] ?? null;
  return primary && modelRoleChoiceKey(primary) === modelRoleChoiceKey(current.primary)
    ? { backups: list.slice(1) }
    : { primary, backups: list.slice(1) };
}
