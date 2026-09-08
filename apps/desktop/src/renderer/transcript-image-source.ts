import type { DesktopBridge } from "@agent-desktop/shared";
import { parseStandaloneFilePath } from "../../../../packages/shared/src/workspace";
import type { MarkdownImageSource } from "./markdown-images";

export interface TranscriptImagePresentation {
  source?: MarkdownImageSource;
  download?(): Promise<void>;
  unavailableReason?: string;
}
export interface TranscriptImageActions {
  /** Host/message identity plus a reconnect generation, not the connection's current boolean. */
  ownerKey: string;
  resolve(href: string): TranscriptImagePresentation;
}
export type TranscriptImageReference = { kind: "file"; path: string } | { kind: "data"; url: string } | { kind: "unavailable"; reason: string };
const unavailable = (reason: string): TranscriptImageReference => ({ kind: "unavailable", reason });

/** Pinned transcript grammar: absolute host paths, sandbox:/ paths and local file URLs.
 * Relative paths require an explicit current-file context; a session cwd is not that context.
 * Remote media stays restricted until an app-owned remote-media policy is implemented.
 */
export function resolveTranscriptImageReference(href: string): TranscriptImageReference {
  if (!href) return unavailable("Image unavailable");
  if (/^data:/i.test(href)) {
    if (href.length > 28_000_000) return unavailable("Embedded image is too large.");
    if (!/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;charset=[a-z0-9-]+)?(?:;base64)?,/i.test(href)) return unavailable("This embedded media type is unavailable.");
    return { kind: "data", url: href };
  }
  if (href.length > 32_768 || /[\p{Cc}\\]/u.test(href)) return unavailable("This image path is invalid.");
  if (/^(?:https?:)?\/\//i.test(href)) return unavailable("Remote images are unavailable in this build.");
  try {
    let path = href.startsWith("sandbox:") ? href.slice(8) : href;
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      if (url.host && url.host !== "localhost" || url.username || url.password) return unavailable("This image does not identify a local path on the owning host.");
      path = decodeURIComponent(url.pathname);
    } else {
      if (!path.startsWith("/") || path.startsWith("//")) return unavailable("Relative images require a file context.");
      path = decodeURIComponent(path.split(/[?#]/, 1)[0]!);
    }
    if (path.startsWith("//")) return unavailable("This image path is invalid.");
    const segments: string[] = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop(); else segments.push(segment);
    }
    return { kind: "file", path: parseStandaloneFilePath(`/${segments.join("/")}`) };
  } catch { return unavailable("This image path is invalid."); }
}

type ImageBridge = Pick<DesktopBridge, "acquireWorkspaceImage" | "releaseWorkspaceImage" | "saveWorkspaceCopy">;
/** Keep host selection explicit. No PATH, viewer filesystem or raw file:// image loading. */
export function createTranscriptImageResolver(bridge: ImageBridge, hostId: string | undefined, isConnected: () => boolean) {
  return (href: string): TranscriptImagePresentation => {
    const reference = resolveTranscriptImageReference(href);
    if (reference.kind === "unavailable") return { unavailableReason: reference.reason };
    if (reference.kind === "data") return { source: { key: reference.url, load: async () => ({ url: reference.url, release() {} }) } };
    if (!hostId || hostId === "unconnected" || !bridge.acquireWorkspaceImage || !bridge.releaseWorkspaceImage) return { unavailableReason: "The image's owning host is unavailable." };
    const target = { filePath: reference.path }, name = reference.path.split("/").at(-1)!;
    return {
      source: {
        key: `${hostId}:${encodeURIComponent(reference.path)}`,
        async load() {
          if (!isConnected()) throw new Error("Reconnect to the owning host to load this image.");
          const lease = await bridge.acquireWorkspaceImage!(target, name, hostId);
          let released = false;
          return { url: lease.url, release: async () => { if (!released) { released = true; await bridge.releaseWorkspaceImage!(lease.id); } } };
        },
      },
      ...(bridge.saveWorkspaceCopy ? { download: async () => {
        if (!isConnected()) throw new Error("Reconnect to the owning host to save this image.");
        await bridge.saveWorkspaceCopy!(target, name, hostId);
      } } : {}),
    };
  };
}
