/** Tools whose presence puts a run in one task family, before the generic chat bucket. */
const FILES_TOOLS = new Set(["shell", "write_file", "read_file", "list_files"]);
const RESEARCH_TOOLS = new Set(["web_search", "web_fetch"]);
const EMAIL_TOOLS = new Set(["read_email", "send_email"]);
const ARTIFACT_TOOLS = new Set(["save_page", "render_plot"]);

/**
 * The narrow task family a run belongs to, used only to show related existing lessons during a
 * review and on the memory page. Never used for recall: recall is semantic and may surface a
 * lesson from another domain. First match wins, so a routine stays its own narrowest domain.
 */
export function lessonDomain(
  run: { routineId: string | null; trigger: string },
  thread: { externalConversationId?: string | null; groupId?: string | null } | null,
  toolNames: readonly string[],
): string {
  if (run.routineId) return `routine:${run.routineId}`;
  if (run.trigger === "helper") return "helper";
  if (run.trigger === "helper_result") return "helper:result";
  if (run.trigger === "bot_message") return "bot_message";
  if (thread?.externalConversationId || run.trigger === "messaging") return "channel";
  if (thread?.groupId) return "group";
  if (toolNames.some((name) => name.startsWith("computer_") || name.startsWith("browser_")))
    return "computer";
  if (toolNames.some((name) => FILES_TOOLS.has(name))) return "files";
  if (toolNames.some((name) => RESEARCH_TOOLS.has(name))) return "research";
  if (toolNames.some((name) => EMAIL_TOOLS.has(name))) return "email";
  if (toolNames.some((name) => ARTIFACT_TOOLS.has(name))) return "artifacts";
  if (toolNames.includes("run_subagent")) return "delegation";
  return "chat";
}
