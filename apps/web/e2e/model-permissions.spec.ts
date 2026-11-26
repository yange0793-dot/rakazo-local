import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("the model panel's three Chinese permission stops save their own modes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/e2e/fixtures/effort.html?theme=light");
  const permissions = page.getByRole("group", { name: "权限" });
  const slider = permissions.getByRole("slider");
  const panel = page.getByRole("main");
  const stops = [
    ["自动", "auto"],
    ["询问", "ask"],
    ["绕过权限", "bypermission"],
  ] as const;
  await expect(permissions.getByRole("button")).toHaveText(stops.map(([label]) => label));
  await expect(slider).toHaveAccessibleDescription("账户默认");
  for (const [label, mode] of stops) {
    const stop = permissions.getByRole("button", { name: label, exact: true });
    await stop.click();
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(slider).toHaveAttribute("aria-valuetext", label);
    await expect(panel).toHaveAttribute("data-saved-approval", mode);
  }
  await expect(panel).toHaveAttribute("data-approval-save-count", "2");
  await expect(panel).toHaveAttribute("data-save-count", "0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await captureScreenshot(page, testInfo, "bot-model-permissions-zh-CN");
});

test("permission drags preview until release and keyboard edits can cancel or commit", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/effort.html?locale=en");
  const permissions = page.getByRole("group", { name: "Permissions" });
  const slider = permissions.getByRole("slider");
  const panel = page.getByRole("main");
  const dots = permissions.locator(".effort-stop-dot");
  const first = (await dots.first().boundingBox())!;
  const fourth = (await dots.nth(1).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(fourth.x + fourth.width / 2, fourth.y + fourth.height / 2, { steps: 6 });
  await expect(slider).toHaveAttribute("aria-valuetext", "Ask");
  await expect(panel).toHaveAttribute("data-approval-save-count", "0");
  await page.mouse.up();
  await expect(panel).toHaveAttribute("data-saved-approval", "auto");
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "Auto");
  await slider.press("Escape");
  await expect(slider).toHaveAttribute("aria-valuetext", "Auto");
  await expect(panel).toHaveAttribute("data-approval-save-count", "1");
  await slider.press("ArrowLeft");
  await slider.press("Enter");
  await expect(panel).toHaveAttribute("data-saved-approval", "ask");
  await slider.press("End");
  await slider.press("Tab");
  await expect(panel).toHaveAttribute("data-saved-approval", "bypermission");
  await expect(panel).toHaveAttribute("data-approval-save-count", "2");
  await expect(panel).toHaveAttribute("data-saved-level", "high");
});
