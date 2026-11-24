import type { TicketFileDeliveryRequirements } from "@rakazo/contracts";
import { csvParseRows } from "d3-dsv";

type ArtifactRequirement = Extract<
  TicketFileDeliveryRequirements["items"][number],
  { kind: "artifact" }
>;
export type FileDeliveryContentConstraint = NonNullable<
  ArtifactRequirement["contentConstraints"]
>[number];

export const MAX_FILE_DELIVERY_CONTENT_BYTES = 1024 * 1024;

export type FileDeliveryContent =
  | { status: "read"; format: "text"; text: string }
  | { status: "read"; format: "csv"; text: string; rows: string[][] }
  | { status: "read"; format: "json"; text: string; value: unknown }
  | {
      status: "unknown";
      reason: "content_unsupported" | "content_unreadable" | "content_too_large";
    };

/** Only complete, decoded content is evidence. Binary formats need a document reader. */
export function readFileDeliveryContent(artifact: {
  mimeType: string;
  bytes: Uint8Array;
}): FileDeliveryContent {
  if (artifact.bytes.byteLength > MAX_FILE_DELIVERY_CONTENT_BYTES)
    return { status: "unknown", reason: "content_too_large" };
  const mime = artifact.mimeType.split(";")[0]!.trim().toLowerCase();
  const format =
    mime === "application/json" || mime.endsWith("+json")
      ? "json"
      : mime === "text/csv"
        ? "csv"
        : ["text/plain", "text/markdown"].includes(mime)
          ? "text"
          : undefined;
  if (!format) return { status: "unknown", reason: "content_unsupported" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
    if (text.includes("\0")) return { status: "unknown", reason: "content_unreadable" };
    if (format === "json") return { status: "read", format, text, value: JSON.parse(text) };
    if (format === "csv") {
      const rows = csvParseRows(text);
      const header = rows[0] ?? [];
      if (
        new Set(header).size !== header.length ||
        rows.some((row) => row.length !== header.length)
      )
        return { status: "unknown", reason: "content_unreadable" };
      return { status: "read", format, text, rows };
    }
    return { status: "read", format, text };
  } catch {
    return { status: "unknown", reason: "content_unreadable" };
  }
}

export function evaluateFileDeliveryContent(
  content: FileDeliveryContent,
  constraints: readonly FileDeliveryContentConstraint[],
): {
  status: "verified" | "issue" | "unknown";
  reason:
    | "content_verified"
    | "content_constraint_mismatch"
    | "content_unsupported"
    | "content_unreadable"
    | "content_too_large";
} {
  if (content.status === "unknown") return content;
  for (const constraint of constraints) {
    let satisfied: boolean;
    switch (constraint.kind) {
      case "text_nonempty":
        satisfied = content.text.trim().length > 0;
        break;
      case "csv_columns":
        if (content.format !== "csv") return { status: "unknown", reason: "content_unsupported" };
        satisfied =
          constraint.columns.every((column) => content.rows[0]?.includes(column)) &&
          Math.max(0, content.rows.length - 1) >= (constraint.minRows ?? 0);
        break;
      case "json_fields":
        if (content.format !== "json") return { status: "unknown", reason: "content_unsupported" };
        // Fields are literal own keys on the root object, not paths or prose matches.
        satisfied =
          content.value !== null &&
          typeof content.value === "object" &&
          !Array.isArray(content.value) &&
          constraint.fields.every((field) => Object.hasOwn(content.value as object, field));
        break;
      default:
        return { status: "unknown", reason: "content_unsupported" };
    }
    if (!satisfied) return { status: "issue", reason: "content_constraint_mismatch" };
  }
  return { status: "verified", reason: "content_verified" };
}
