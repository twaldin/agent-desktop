const attributes: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"], blockquote: ["cite"], img: ["src", "sizes", "alt", "title", "width", "height"],
  li: ["value"], ol: ["start"], q: ["cite"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], time: ["datetime"],
};
const supportedElements = new Set(["a", "blockquote", "br", "code", "del", "em", "img", "li", "ol", "p", "pre", "q", "span", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "ul"]);
const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const unsafeElements = new Set(["base", "embed", "iframe", "link", "meta", "object", "script", "style"]);
const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");
const children = (node: Node) => Array.from(node.childNodes);
const marker = (node: Element, value: string) => node.getAttribute("data-markdown-copy") === value;

function containsCodeBlock(node: Node): boolean {
  return node.nodeType === 1 && (marker(node as Element, "code-block") || children(node).some(containsCodeBlock));
}
function excluded(node: Element): boolean {
  return marker(node, "exclude") || node.getAttribute("aria-hidden") === "true"
    || (node.getAttribute("class") ?? "").split(/\s+/).includes("sr-only")
    || node.localName.toLowerCase() === "img" && (node.getAttribute("alt") ?? "") === "";
}
function runtimeImage(value: string | null): boolean {
  return value !== null && /\b(?:agent-workspace-image|blob):/i.test(value);
}
function safeUrl(name: string, value: string): boolean {
  if (/[\x00-\x20\x7f\\]/.test(value)) return false;
  if (name === "src") {
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;charset=[a-z0-9-]+)?(?:;base64)?,/i.test(value)) return true;
  } else if (value.startsWith("#")) return value.length > 1;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:");
  } catch { return false; }
}
function serialize(node: Node): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element, name = element.localName.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name) || unsafeElements.has(name) || excluded(element)) return "";
  if (name === "button" || element.hasAttribute("data-file-reference")) {
    return containsCodeBlock(element) ? children(element).map(serialize).join("") : escapeText(element.textContent ?? "");
  }
  if (marker(element, "code-block")) return `<pre dir="ltr"><code>${escapeText(element.textContent ?? "")}</code></pre>`;
  if (marker(element, "rich-block")) return children(element).map(serialize).join("");
  if (marker(element, "inline-code")) return `<code dir="ltr">${escapeText(element.textContent ?? "")}</code>`;
  if (!supportedElements.has(name)) return escapeText(element.textContent ?? "");
  if (name === "img" && (runtimeImage(element.getAttribute("src")) || runtimeImage(element.getAttribute("srcset")) || !safeUrl("src", element.getAttribute("src") ?? ""))) return escapeText(element.getAttribute("alt") ?? "");
  const copied = (attributes[name] ?? []).flatMap(attribute => {
    const value = element.getAttribute(attribute);
    return value === null || ["href", "cite", "src"].includes(attribute) && !safeUrl(attribute, value) ? [] : [` ${attribute}="${escapeAttribute(value)}"`];
  }).join("");
  const content = children(element).map(serialize).join("");
  return voidElements.has(name) ? `<${name}${copied}>` : `<${name}${copied}>${content}</${name}>`;
}

/** Produce inert clipboard HTML without copying renderer state or action controls. */
export function sanitizedTableHtml(table: HTMLTableElement): string {
  if (table?.nodeType !== 1 || table.localName.toLowerCase() !== "table") throw new Error("A rendered table is required for copying.");
  return serialize(table);
}

/** Copy exact source Markdown plus a safe rich-table representation when supported. */
export async function copyTranscriptTable(table: HTMLTableElement, markdownSource: string): Promise<void> {
  if (typeof markdownSource !== "string") throw new Error("Table Markdown is unavailable.");
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.write === "function" && typeof ClipboardItem === "function") {
    await clipboard.write([new ClipboardItem({
      "text/plain": new Blob([markdownSource], { type: "text/plain" }),
      "text/html": new Blob([sanitizedTableHtml(table)], { type: "text/html" }),
    })]);
    return;
  }
  if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard writing is unavailable.");
  await clipboard.writeText(markdownSource);
}
