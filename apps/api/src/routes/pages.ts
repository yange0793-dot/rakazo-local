import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { BrowserProvider } from "@rakazo/adapter-kit";
import { createBrowserProvider, toComputerRef } from "@rakazo/adapters";
import {
  getPage,
  listPages,
  PageListCursorError,
  PageShareConflictError,
  pinPage,
  removePage,
  renamePage,
  setPageVisibility,
} from "../pages.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function pagesRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  let browser: BrowserProvider | undefined;
  const browserProvider = process.env.BROWSER_PROVIDER?.trim().toLowerCase();
  const pageDeps = () => ({
    prisma: deps.prisma,
    secrets: deps.secrets,
    webOrigin: deps.env.webOrigin,
  });
  return {
    pages: {
      list: authed.pages.list.handler(async ({ context, input }) => {
        try {
          return await listPages(deps.prisma, context.actor, input);
        } catch (error) {
          if (error instanceof PageListCursorError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      get: authed.pages.get.handler(({ context, input }) =>
        getPage(pageDeps(), context.actor, input),
      ),
      frame: authed.pages.frame.handler(async ({ context, input }) => {
        const page = await getPage(pageDeps(), context.actor, { pageId: input.pageId });
        if (
          page.visibility !== "private" ||
          !page.botId ||
          page.title.trim().toLowerCase() !== "gemini" ||
          browserProvider !== "ego"
        ) {
          return { image: null };
        }
        const bot = await repos.getBot(context.actor, page.botId);
        if (!bot.computer?.providerRef || bot.computer.state !== "running") {
          return { image: null };
        }
        const effect = await deps.prisma.externalEffect.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            run: { botId: bot.id, userId: context.actor.userId },
            kind: { in: ["browser_navigate", "browser_snapshot", "browser_act"] },
            status: "completed",
            AND: [
              { result: { path: ["browserState", "computerId"], equals: bot.computer.id } },
              { result: { path: ["url"], string_starts_with: "https://gemini.google.com/" } },
            ],
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          select: { result: true },
        });
        const result = effect?.result as
          | { browserState?: { computerId?: unknown; provider?: unknown } }
          | null
          | undefined;
        const saved = result?.browserState;
        if (
          saved?.computerId !== bot.computer.id ||
          !saved.provider ||
          typeof saved.provider !== "object"
        ) {
          return { image: null };
        }
        browser ??= createBrowserProvider(browserProvider);
        if (!browser.readFrame || !browser.restore) return { image: null };
        const computer = toComputerRef(bot.computer);
        const adapterContext = computerContext(context.actor, bot.id, `page.frame:${randomUUID()}`);
        browser.restore(computer, saved.provider, adapterContext);
        const frame = await browser.readFrame(computer, undefined, {
          ...adapterContext,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { image: frame ? Buffer.from(frame).toString("base64") : null };
      }),
      rename: authed.pages.rename.handler(({ context, input }) =>
        renamePage(deps.prisma, context.actor, input.pageId, input.title),
      ),
      setVisibility: authed.pages.setVisibility.handler(async ({ context, input }) => {
        try {
          return await setPageVisibility(
            pageDeps(),
            context.actor,
            input,
            context.signal ?? new AbortController().signal,
          );
        } catch (error) {
          if (error instanceof PageShareConflictError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          throw error;
        }
      }),
      pin: authed.pages.pin.handler(({ context, input }) =>
        pinPage(deps.prisma, context.actor, input.pageId, input.pinned),
      ),
      remove: authed.pages.remove.handler(({ context, input }) =>
        removePage(pageDeps(), context.actor, input.pageId),
      ),
    },
  };
}
