export interface TranscriptMarkdownClipboardPayload { plainText: string; htmlText: string }

const attributes: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"], blockquote: ["cite"], img: ["src", "sizes", "alt", "title", "width", "height"],
  li: ["value"], ol: ["start"], pre: ["dir"], q: ["cite"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], time: ["datetime"],
};
const supported = new Set(["a", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "pre", "q", "s", "span", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "ul"]);
const voidElements = new Set(["br", "hr", "img"]);
const unsafe = new Set(["base", "embed", "iframe", "link", "meta", "object", "script", "style"]);
const blocks = new Set(["blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "pre"]);
const childNodes = (node: Node): Node[] => Array.from(node.childNodes);
const elementName = (node: Node): string => node.nodeType === 1 ? (node as Element).localName.toLowerCase() : "";
const attribute = (node: Node, name: string): string | null => node.nodeType === 1 ? (node as Element).getAttribute(name) : null;
const marked = (node: Node, value: string): boolean => attribute(node, "data-markdown-copy") === value;
const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");

function excluded(node: Node): boolean {
  return marked(node, "exclude") || attribute(node, "aria-hidden") === "true"
    || (attribute(node, "class") ?? "").split(/\s+/).includes("sr-only")
    || elementName(node) === "img" && (attribute(node, "alt") ?? "") === "";
}
function descendant(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
  for (const child of childNodes(node)) {
    if (predicate(child)) return child;
    const nested = descendant(child, predicate); if (nested) return nested;
  }
}
function containsCodeBlock(node: Node): boolean {
  return marked(node, "code-block") || childNodes(node).some(containsCodeBlock);
}
function codeText(node: Node): string {
  const source = attribute(node, "data-markdown-copy-text");
  if (source !== null) return source;
  const pre = descendant(node, child => elementName(child) === "pre");
  const code = pre && descendant(pre, child => elementName(child) === "code");
  return code?.textContent ?? pre?.textContent ?? "";
}
function runtimeImage(value: string | null): boolean {
  return value !== null && /\b(?:agent-workspace-image|blob):/i.test(value);
}
function safeUrl(name: string, value: string): boolean {
  if (/[\x00-\x20\x7f\\]/.test(value)) return false;
  if (name === "src" && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;charset=[a-z0-9-]+)?(?:;base64)?,/i.test(value)) return true;
  if (name !== "src" && value.startsWith("#")) return value.length > 1;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:"); }
  catch { return false; }
}
export function sanitizedMarkdownHtml(node: Node): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? "");
  if (node.nodeType === 11) return childNodes(node).map(sanitizedMarkdownHtml).join("");
  if (node.nodeType !== 1 || excluded(node)) return "";
  const name = elementName(node);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || unsafe.has(name)) return "";
  if (name === "button" || attribute(node, "data-file-reference") !== null) return containsCodeBlock(node) ? childNodes(node).map(sanitizedMarkdownHtml).join("") : escapeText(node.textContent ?? "");
  if (marked(node, "code-block")) return `<pre dir="ltr"><code>${escapeText(codeText(node))}</code></pre>`;
  if (marked(node, "rich-block")) return childNodes(node).map(sanitizedMarkdownHtml).join("");
  if (marked(node, "inline-code")) return `<code dir="ltr">${escapeText(node.textContent ?? "")}</code>`;
  if (!supported.has(name)) return childNodes(node).map(sanitizedMarkdownHtml).join("");
  if (name === "img" && (runtimeImage(attribute(node, "src")) || runtimeImage(attribute(node, "srcset")) || !safeUrl("src", attribute(node, "src") ?? ""))) return escapeText(attribute(node, "alt") ?? "");
  const copied = (attributes[name] ?? []).flatMap(key => {
    const value = attribute(node, key);
    if (value === null || ["href", "cite", "src"].includes(key) && !safeUrl(key, value) || key === "dir" && value !== "ltr") return [];
    return [` ${key}="${escapeAttribute(value)}"`];
  }).join("");
  const content = childNodes(node).map(sanitizedMarkdownHtml).join("");
  return voidElements.has(name) ? `<${name}${copied}>` : `<${name}${copied}>${content}</${name}>`;
}
function tableRow(node: Node): string {
  return childNodes(node).filter(child => ["th", "td"].includes(elementName(child))).map(child => childNodes(child).map(plain).join("").trim()).join("\t");
}
function list(node: Node, indent: string): string {
  const ordered = elementName(node) === "ol", items = childNodes(node).filter(child => elementName(child) === "li");
  let number = Number(attribute(node, "start") ?? "1"); if (!Number.isFinite(number)) number = 1;
  return items.map(item => {
    if (ordered && attribute(item, "value") !== null) { const value = Number(attribute(item, "value")); if (Number.isFinite(value)) number = value; }
    const prefix = ordered ? `${number++}. ` : "- ", continuation = indent + " ".repeat(prefix.length);
    let started = false, buffered = "", result = "";
    const flush = () => {
      const lines = buffered.trim().split("\n"); buffered = "";
      if (lines.length === 1 && lines[0] === "") return;
      for (const line of lines) { result += `${started ? continuation : indent + prefix}${line}\n`; started = true; }
    };
    for (const child of childNodes(item)) {
      if (["ol", "ul"].includes(elementName(child))) { flush(); if (!started) { result += `${indent}${prefix.trimEnd()}\n`; started = true; } result += list(child, continuation); }
      else buffered += plain(child);
    }
    flush(); return started ? result : `${indent}${prefix.trimEnd()}\n`;
  }).join("");
}
function plain(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType === 11) return childNodes(node).map(plain).join("");
  if (node.nodeType !== 1 || excluded(node) || unsafe.has(elementName(node))) return "";
  const name = elementName(node);
  if (name === "button" || attribute(node, "data-file-reference") !== null) return containsCodeBlock(node) ? childNodes(node).map(plain).join("") : node.textContent ?? "";
  if (marked(node, "code-block")) return `${codeText(node)}\n`;
  if (marked(node, "rich-block") || marked(node, "inline-code")) return childNodes(node).map(plain).join("");
  if (name === "img") return attribute(node, "alt") ?? "";
  if (name === "table") return descendants(node, child => elementName(child) === "tr").map(tableRow).join("\n");
  if (name === "tr") return `${tableRow(node)}\n`;
  if (["thead", "tbody", "tfoot"].includes(name)) return childNodes(node).map(plain).join("");
  if (name === "br") return "\n";
  if (name === "ol" || name === "ul") return list(node, "");
  const content = childNodes(node).map(plain).join("");
  return blocks.has(name) ? `${content}\n` : content;
}
function descendants(node: Node, predicate: (candidate: Node) => boolean): Node[] {
  const result: Node[] = [];
  for (const child of childNodes(node)) { if (predicate(child)) result.push(child); result.push(...descendants(child, predicate)); }
  return result;
}

/** Build the safe rich and structural plain payload for a broad selection crossing code. */
export function transcriptMarkdownSelection(root: HTMLElement, selection: Selection | null = root.ownerDocument.getSelection()): TranscriptMarkdownClipboardPayload | undefined {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const codeBlocks = descendants(root, node => marked(node, "code-block"));
  if (!codeBlocks.some(node => { try { return range.intersectsNode(node); } catch { return false; } })) return;
  const fragment = range.cloneContents(), plainText = plain(fragment).trim();
  if (!plainText) return;
  return { plainText, htmlText: sanitizedMarkdownHtml(fragment) };
}
