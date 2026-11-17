import type { AdapterContext } from "./types.js";

/** Only persisted, scoped conversation text enters an optional background extractor. */
export interface MemoryExtractionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** New user messages can support mutations; older messages are context only. */
  isNew: boolean;
}

export interface MemoryExtractionExisting {
  id: string;
  revision: number;
  content: string;
  status: "active" | "historical" | "forgotten";
  sourceMessageId?: string;
  sourceQuote?: string;
  category?: MemoryExtractionCategory;
}

export type MemoryExtractionCategory = "preference" | "project" | "experience" | "reference";

export interface MemoryExtractionNote {
  scope: "bot" | "user";
  path: string;
  revision: number;
  content: string;
}

export interface MemoryExtractionRequest {
  messages: MemoryExtractionMessage[];
  /** Recalled active facts and source-related retirement evidence, not a second fact store. */
  existing: MemoryExtractionExisting[];
  /** Existing Markdown notes inform extraction but remain owned by the user and the bot. */
  notes: MemoryExtractionNote[];
}

/** A proposed mutation, not permission to write. The host validates its real source again. */
export interface MemoryExtractionChange {
  content: string;
  sourceMessageId: string;
  sourceQuote: string;
  category: MemoryExtractionCategory;
  /** A correction names an existing active fact; the host binds its observed revision. */
  replacesId?: string;
  expectedRevision?: number;
}

export interface MemoryExtractor {
  extract(
    request: MemoryExtractionRequest,
    context: AdapterContext,
  ): Promise<MemoryExtractionChange[]>;
}
