import { resolveMarkdownLink } from "./markdown-links";
import { fromMarkdown } from "mdast-util-from-markdown";

export interface MarkdownImageLease { url: string; release(): void | Promise<void> }
export interface MarkdownImageSource { key: string; load(): Promise<MarkdownImageLease> }
export type MarkdownImageResolver = (href: string) => MarkdownImageSource | null;

/** Mirrors the file editor's local-path grammar; web/data images remain source text. */
export function markdownImagePath(href: string, filePath: string, workspacePath: string): string | null {
  if (!href || /[\\\r\n\ud800-\udfff]/.test(href)) return null;
  const value = resolveMarkdownLink(href, filePath, workspacePath);
  return value.kind === "file" && !/[\ud800-\udfff]/.test(value.file.path) ? value.file.path : null;
}

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>["children"][number];
export interface ParsedMarkdownImage { to: number; href: string; alt: string; title?: string }
/** Reuse the CommonMark parser already backing transcript Markdown, including definitions. */
export function parseMarkdownImages(text: string): Map<number, ParsedMarkdownImage> {
  const tree = fromMarkdown(text), definitions = new Map<string, { url: string; title?: string | null }>();
  const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => {
    visit(node);
    if ("children" in node) for (const child of node.children) walk(child, visit);
  };
  walk(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  const images = new Map<number, ParsedMarkdownImage>();
  walk(tree, node => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const from = node.position?.start.offset, to = node.position?.end.offset;
    const source = node.type === "image" ? node : definitions.get(node.identifier);
    if (!source || from === undefined || to === undefined || /[\r\n]/.test(text.slice(from, to)) || /[\t\n\v\f\r\u0085\u2028\u2029]/.test(node.alt ?? "")) return;
    images.set(from, { to, href: source.url, alt: node.alt ?? "", ...(source.title == null ? {} : { title: source.title }) });
  });
  return images;
}
