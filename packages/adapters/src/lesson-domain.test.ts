import { describe, expect, it } from "vitest";
import { lessonDomain } from "./lesson-domain.js";

const botChat = { groupId: null, externalConversationId: null };

describe("lessonDomain", () => {
  it("keeps a routine its own narrow domain", () => {
    expect(
      lessonDomain({ routineId: "routine-1", trigger: "routine" }, botChat, ["web_search"]),
    ).toBe("routine:routine-1");
  });

  it("names the run's origin before its tools", () => {
    expect(lessonDomain({ routineId: null, trigger: "helper" }, botChat, [])).toBe("helper");
    expect(lessonDomain({ routineId: null, trigger: "helper_result" }, botChat, [])).toBe(
      "helper:result",
    );
    expect(lessonDomain({ routineId: null, trigger: "bot_message" }, botChat, [])).toBe(
      "bot_message",
    );
    expect(lessonDomain({ routineId: null, trigger: "messaging" }, botChat, [])).toBe("channel");
    expect(
      lessonDomain(
        { routineId: null, trigger: "user" },
        { ...botChat, externalConversationId: "x" },
        [],
      ),
    ).toBe("channel");
    expect(
      lessonDomain({ routineId: null, trigger: "user" }, { ...botChat, groupId: "group-1" }, [
        "web_fetch",
      ]),
    ).toBe("group");
  });

  it("falls back to the tool family, then to chat", () => {
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["browser_act"])).toBe(
      "computer",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["write_file"])).toBe(
      "files",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["web_search"])).toBe(
      "research",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["send_email"])).toBe(
      "email",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["render_plot"])).toBe(
      "artifacts",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["run_subagent"])).toBe(
      "delegation",
    );
    expect(lessonDomain({ routineId: null, trigger: "user" }, botChat, ["ask_user"])).toBe("chat");
    expect(lessonDomain({ routineId: null, trigger: "user" }, null, [])).toBe("chat");
  });
});
