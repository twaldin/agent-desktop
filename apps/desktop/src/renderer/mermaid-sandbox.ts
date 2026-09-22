import { prepareMermaid, type RenderedDiagram } from "./transcript-diagram";

/** Neither model markup nor Mermaid's measuring DOM enters the application document.
 * The build-generated document authorizes only its two trusted scripts by content hash. */
export function renderMermaidDiagram(code: string, dark: boolean, fontFamily: string, signal: AbortSignal): Promise<RenderedDiagram> {
  signal.throwIfAborted();
  const prepared = prepareMermaid(code);
  if (!prepared?.trim()) return Promise.reject(new Error("Mermaid source cannot be rendered."));
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts"); frame.title = "Isolated diagram renderer"; frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1600px;height:1200px;visibility:hidden;pointer-events:none;border:0";
  frame.src = new URL("./mermaid-sandbox.html", document.baseURI).href;
  return new Promise((resolve, reject) => {
    let handshake: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(handshake); window.removeEventListener("message", receive); signal.removeEventListener("abort", abort); frame.remove(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !event.data || event.data.channel !== "transcript-mermaid") return;
      if (event.data.type === "ready") { clearTimeout(handshake); frame.contentWindow?.postMessage({ channel: "transcript-mermaid", code: prepared, dark, fontFamily, opaque: document.documentElement.dataset.opaqueWindowSurface !== "false" }, "*"); return; }
      if (event.data.type !== "result") return;
      const value = event.data.diagram;
      cleanup();
      if (typeof value?.svg === "string" && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0) resolve(value);
      else reject(new Error("Mermaid source cannot be rendered."));
    };
    window.addEventListener("message", receive); signal.addEventListener("abort", abort, { once: true });
    frame.addEventListener("error", () => { cleanup(); reject(new Error("The diagram renderer could not be loaded.")); }, { once: true });
    document.body.append(frame);
    handshake = setTimeout(() => { cleanup(); reject(new Error("The diagram renderer could not be loaded.")); }, 10_000);
  });
}
