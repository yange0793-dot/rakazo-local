/** The host asks for a stable paper layout before opening its print dialog. */
export function installPrintPreparation(): () => void {
  const rules = new Map<CSSMediaRule, string>();
  const restore = () => {
    for (const node of document.querySelectorAll("[data-page-print-insert]")) node.remove();
    for (const [rule, media] of rules) rule.media.mediaText = media;
    rules.clear();
    window.dispatchEvent(new Event("afterprint"));
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === "rakazo-page:restore-print") {
      restore();
      return;
    }
    if (event.data?.type !== "rakazo-page:prepare-print") return;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSMediaRule && rule.media.mediaText === "print") {
          rules.set(rule, rule.media.mediaText);
          rule.media.mediaText = "all";
        }
      }
    }
    window.dispatchEvent(new Event("beforeprint"));
    // Theme subscribers and table pagination render before the height is returned.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // A sandboxed iframe is printed as one tall surface: CSS break-inside cannot
        // move its rows. Align them to A4's 273mm content area (12mm margins).
        const pageHeight = (273 / 25.4) * 96;
        const rows = [...document.querySelectorAll<HTMLTableRowElement>("table tbody > tr")];
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          const top = rect.top + window.scrollY;
          const remaining = pageHeight - (top % pageHeight);
          if (rect.height <= remaining || rect.height >= pageHeight) continue;
          const spacer = document.createElement("tr");
          spacer.dataset.pagePrintInsert = "";
          const cell = spacer.insertCell();
          cell.colSpan = row.cells.length;
          cell.style.cssText = `height:${remaining + 1}px;padding:0;border:0;background:transparent`;
          row.before(spacer);
          const head = row.closest("table")?.tHead;
          for (const heading of head?.rows ?? []) {
            const repeated = heading.cloneNode(true) as HTMLTableRowElement;
            repeated.dataset.pagePrintInsert = "";
            row.before(repeated);
          }
        }
        window.parent.postMessage(
          { type: "rakazo-page:print-ready", height: document.body.scrollHeight },
          "*",
        );
      }),
    );
  };
  window.addEventListener("message", receive);
  return () => {
    window.removeEventListener("message", receive);
    restore();
  };
}
