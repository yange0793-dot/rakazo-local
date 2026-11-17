import { pageFrameHeight } from "./page-cards";

/** Wait for the sandbox to finish its paper layout before the browser captures it. */
export async function printPage(page: HTMLElement): Promise<void> {
  const box = page.querySelector<HTMLElement>("[data-page-frame]");
  const target = box?.querySelector("iframe")?.contentWindow;
  if (!box || !target) throw new Error("Page is not ready");
  let timer: number | undefined;
  let receive: (event: MessageEvent) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    receive = (event) => {
      if (
        event.source === target &&
        event.data?.type === "rakazo-page:print-ready" &&
        Number.isFinite(event.data.height)
      ) {
        resolve(pageFrameHeight(event.data.height));
      }
    };
    window.addEventListener("message", receive);
    timer = window.setTimeout(() => reject(new Error("Page print preparation timed out")), 15_000);
  });
  page.dataset.pagePrintPreparing = "";
  target.postMessage({ type: "rakazo-page:prepare-print" }, "*");
  try {
    const height = await ready;
    box.style.setProperty("--page-height", `${height}px`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await window.print();
  } finally {
    window.clearTimeout(timer);
    window.removeEventListener("message", receive);
    delete page.dataset.pagePrintPreparing;
    target.postMessage({ type: "rakazo-page:restore-print" }, "*");
  }
}
