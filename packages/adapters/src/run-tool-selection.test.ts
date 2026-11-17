import { describe, expect, it } from "vitest";
import { BACKGROUND_HELPER_TOOL_NAMES, selectBuiltinToolsForRun } from "./run-tool-selection.js";

const helperOptions = {
  graphicalToolsAllowed: true,
  pageBrowserAllowed: true,
  groupId: null,
  trigger: "helper",
  semanticMemoryEnabled: true,
  messagingChannelRun: false,
};

describe("background helper tools", () => {
  it("offers the page browser beside its files, shell and reads", () => {
    const names = selectBuiltinToolsForRun(helperOptions).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]),
    );
    for (const name of ["web_search", "web_fetch", "read_file", "write_file", "shell"]) {
      expect(names).toContain(name);
      expect(BACKGROUND_HELPER_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("keeps the screen, the user's computer and every owner-only write away", () => {
    const names = new Set(
      selectBuiltinToolsForRun({
        ...helperOptions,
        fleetManagement: true,
        paymentWalletEnabled: true,
        phoneCallsEnabled: true,
        emailInbox: true,
        emailSend: true,
        emailClaimable: true,
        userComputer: true,
        userComputerScreen: true,
        paidServicesEnabled: true,
        cloudAgentEnabled: true,
        ticketBoardEnabled: true,
        historyRetrievalEnabled: true,
        mediaImagesEnabled: true,
        mediaVideoEnabled: true,
        semanticMemoryForgets: true,
      }).map((tool) => tool.name),
    );
    for (const name of [
      "computer_observe",
      "computer_act",
      "user_computer_shell",
      "user_computer_observe",
      "user_computer_act",
      "request_purchase",
      "request_secret",
      "remember",
      "save_memory",
      "forget_memory",
      "schedule_create",
      "spawn_bot",
      "run_subagent",
      "message_user",
      "send_email",
    ]) {
      expect(names.has(name)).toBe(false);
    }
  });

  it("drops the page browser where the run may not use one", () => {
    const names = selectBuiltinToolsForRun({
      ...helperOptions,
      graphicalToolsAllowed: false,
      pageBrowserAllowed: false,
    }).map((tool) => tool.name);
    expect(names).not.toContain("browser_navigate");
    expect(names).not.toContain("browser_snapshot");
    expect(names).not.toContain("browser_act");
  });
});
