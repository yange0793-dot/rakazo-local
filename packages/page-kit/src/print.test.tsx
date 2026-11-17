// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Table } from "./kit/data.js";
import { installPrintPreparation } from "./print.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("prepares only for the host and restores print rules after reporting the full height", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const style = document.createElement("style");
  style.textContent = "@media print { table { overflow: visible; } }";
  document.head.append(style);
  const rule = style.sheet!.cssRules[0] as CSSMediaRule;
  const posted = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  const before = vi.fn();
  window.addEventListener("beforeprint", before);
  const stop = installPrintPreparation();
  const send = (type: string, source: Window | null) =>
    window.dispatchEvent(new MessageEvent("message", { source, data: { type } }));
  send("rakazo-page:prepare-print", null);
  expect(before).not.toHaveBeenCalled();
  send("rakazo-page:prepare-print", window.parent);
  expect(before).toHaveBeenCalledTimes(1);
  expect(rule.media.mediaText).toBe("all");
  expect(posted).not.toHaveBeenCalled();
  while (frames.length) frames.shift()!(0);
  expect(posted).toHaveBeenCalledWith(
    { type: "rakazo-page:print-ready", height: document.body.scrollHeight },
    "*",
  );
  send("rakazo-page:restore-print", window.parent);
  expect(rule.media.mediaText).toBe("print");
  stop();
  window.removeEventListener("beforeprint", before);
  style.remove();
});

it("includes rows beyond the screen page limit during printing and restores the screen afterward", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <Table columns={["Row"]} rows={Array.from({ length: 220 }, (_, index) => [index + 1])} />,
    ),
  );
  expect(document.querySelectorAll("tbody tr")).toHaveLength(200);
  await act(async () => window.dispatchEvent(new Event("beforeprint")));
  expect(document.querySelectorAll("tbody tr")).toHaveLength(220);
  await act(async () => window.dispatchEvent(new Event("afterprint")));
  expect(document.querySelectorAll("tbody tr")).toHaveLength(200);
  await act(async () => root.unmount());
});

it("moves a row that crosses a paper boundary and repeats its table header only for printing", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  const table = document.createElement("table");
  table.createTHead().insertRow().insertCell().textContent = "Amount";
  const row = table.createTBody().insertRow();
  row.insertCell().textContent = "1.00";
  document.body.append(table);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    top: 1025,
    height: 35,
  } as DOMRect);
  const stop = installPrintPreparation();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window.parent,
      data: { type: "rakazo-page:prepare-print" },
    }),
  );
  while (frames.length) frames.shift()!(0);
  expect(table.querySelectorAll("[data-page-print-insert]")).toHaveLength(2);
  expect(row.previousElementSibling?.textContent).toBe("Amount");
  expect(Number.parseFloat(table.tBodies[0]!.rows[0]!.cells[0]!.style.height)).toBeGreaterThan(6);
  stop();
  expect(table.tBodies[0]!.rows).toHaveLength(1);
  expect(table.tBodies[0]!.textContent).toBe("1.00");
});
