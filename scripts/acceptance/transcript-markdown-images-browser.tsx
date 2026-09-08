import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopBridge } from "../../packages/shared/src/protocol";
import { MarkdownText, TranscriptMarkdownContext } from "../../apps/desktop/src/renderer/MarkdownText";
import { MarkdownViewState } from "../../apps/desktop/src/renderer/markdown-state";
import { createTranscriptImageResolver } from "../../apps/desktop/src/renderer/transcript-image-source";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const hostId = params.get("hostId")!;
const firstPath = params.get("firstPath")!;
const secondPath = params.get("secondPath")!;
const missingPath = params.get("missingPath")!;
const dataImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const markdown = [
  "# Transcript image fixture",
  `![Absolute local](${firstPath.replaceAll(" ", "%20")} \"First title\")`,
  `![Repeated absolute](${firstPath.replaceAll(" ", "%20")} \"Repeated title\")`,
  `![File localhost](file://localhost${secondPath.replaceAll(" ", "%20")})`,
  `![Sandbox absolute](sandbox:${secondPath.replaceAll(" ", "%20")})`,
  `![Missing local](${missingPath.replaceAll(" ", "%20")})`,
  "![Relative unavailable](relative-image.png)",
  "![Remote unavailable](https://example.invalid/never-request.png)",
  `![Embedded data](${dataImage})`,
].join("\n\n");
const bridge = (window as any).agentDesktop as Pick<DesktopBridge, "acquireWorkspaceImage" | "releaseWorkspaceImage" | "saveWorkspaceCopy">;
const runtimeErrors: string[] = [];
window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
let changeConnection: (value: boolean) => void;
let replaceOwner: () => void;
let changeMounted: (value: boolean) => void;
let currentConnected = true;

function Fixture() {
  const [connected, setConnected] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(true);
  currentConnected = connected;
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const resolver = useMemo(() => createTranscriptImageResolver(bridge, hostId, () => connectedRef.current), []);
  const ownerKey = `${hostId}:transcript-fixture:${generation}`;
  const views = useMemo(() => new MarkdownViewState(), []);
  changeConnection = value => { if (value && !connectedRef.current) setGeneration(current => current + 1); setConnected(value); };
  replaceOwner = () => setGeneration(current => current + 1);
  changeMounted = setMounted;
  return <main className="transcript-image-fixture">
    <button className="fixture-focus">Fixture focus</button>
    <p data-owner-key={ownerKey}>Owner {ownerKey}</p>
    {mounted && <TranscriptMarkdownContext value={{ views, actions: { images: { ownerKey, resolve: resolver } } }}><MarkdownText text={markdown} blockKey="transcript-image:block:0"/></TranscriptMarkdownContext>}
  </main>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
Object.assign(window, {
  connection: (value: boolean) => changeConnection(value), replaceOwner: () => replaceOwner(), mounted: (value: boolean) => changeMounted(value),
  failThumbnail(label: string) { const button = visible(".transcript-markdown-image").find(node => node.ariaLabel === label); const image = button?.querySelector("img"); if (!image) throw new Error(`Missing image ${label}`); image.dispatchEvent(new Event("error")); },
  target(selector: string, label?: string) { const node = visible(selector).find(item => label === undefined || item.textContent?.trim() === label || item.getAttribute("aria-label") === label); if (!node) throw new Error(`Missing ${selector} ${label ?? ""}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() {
    const dialog = document.querySelector<HTMLDialogElement>(".transcript-markdown-image-dialog[open]");
    const preview = dialog?.querySelector<HTMLImageElement>(".transcript-markdown-image-viewport > img");
    const firstThumbnail = visible(".transcript-markdown-image").find(node => node.ariaLabel === "Absolute local");
    const firstImage = firstThumbnail?.querySelector<HTMLImageElement>("img");
    const rootStyle = getComputedStyle(document.documentElement), bodyStyle = getComputedStyle(document.body);
    return {
      ownerKey: document.querySelector<HTMLElement>("[data-owner-key]")?.dataset.ownerKey,
      connected: currentConnected, mounted: Boolean(document.querySelector(".transcript-markdown")),
      thumbnails: visible(".transcript-markdown-image").map(node => { const image = node.querySelector<HTMLImageElement>("img"); return { label: node.ariaLabel, title: node.title, src: image?.getAttribute("src"), loaded: Boolean(image?.complete && image.naturalWidth > 0), naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight, rect: node.getBoundingClientRect().toJSON(), imageRect: image?.getBoundingClientRect().toJSON() }; }),
      unavailable: visible(".transcript-markdown-image-unavailable").filter(node => !node.closest("dialog")).map(node => ({ text: node.innerText, title: node.title })),
      dialog: dialog ? { label: dialog.ariaLabel, previewAlt: preview?.alt, previewTitle: preview?.title, previewLoaded: Boolean(preview?.complete && preview.naturalWidth > 0), naturalWidth: preview?.naturalWidth, naturalHeight: preview?.naturalHeight, transform: preview?.style.transform, download: Boolean(dialog.querySelector('[aria-label="Download image"]')), next: Boolean(dialog.querySelector('[aria-label="Next image"]')), previous: Boolean(dialog.querySelector('[aria-label="Previous image"]')) } : undefined,
      focused: document.activeElement instanceof HTMLElement ? document.activeElement.ariaLabel || document.activeElement.innerText : undefined,
      body: document.body.innerText, runtimeErrors: [...runtimeErrors], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale },
      presentation: { theme: document.documentElement.dataset.theme, rootFont: rootStyle.font, bodyFont: bodyStyle.font, color: bodyStyle.color, thumbnailMaxWidth: firstThumbnail ? getComputedStyle(firstThumbnail).maxWidth : undefined, imageMaxWidth: firstImage ? getComputedStyle(firstImage).maxWidth : undefined },
    };
  },
});
