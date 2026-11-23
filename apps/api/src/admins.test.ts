import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { isAdmin } from "./admins.js";

describe("isAdmin", () => {
  const prisma = {
    deploymentSettings: {
      findUnique: async () => ({ ownerUserId: "local-owner" }),
    },
  } as unknown as PrismaClient;

  it("grants only the local deployment owner administration", async () => {
    expect(await isAdmin({ prisma }, "local-owner")).toBe(true);
    expect(await isAdmin({ prisma }, "chat-contact")).toBe(false);
  });
});
