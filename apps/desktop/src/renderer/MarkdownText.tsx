import { FileReferenceControl } from "./TranscriptFileReference";
import { TranscriptMarkdownImage } from "./TranscriptMarkdownImage";
import { TranscriptMarkdownTable } from "./TranscriptMarkdownTable";
import { createTranscriptImageResolver } from "./transcript-image-source";
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "./transcript-code-highlight";
import { useCodeHighlight } from "./use-code-highlight";
import { useCodeCopy } from "./use-code-copy";
import { codeFenceOpen } from "./transcript-code-fence";
import { codeLanguageLabel } from "./transcript-code-language";
import { transcriptMarkdownSelection } from "./transcript-markdown-copy";
import { TranscriptCodeIcon } from "./TranscriptCodeIcons";
export { highlightCode, HIGHLIGHT_LIMIT } from "./transcript-code-highlight";
import { markdownScope, MarkdownViewState } from "./markdown-state";
import { resolveTranscriptLink, type TranscriptLinkActions } from "./transcript-links";
import { SelectableCode } from "./code-selection";
import "./markdown.css";

export const TranscriptMarkdownContext = createContext<{ actions?: TranscriptLinkActions; views?: MarkdownViewState }>({});
const MarkdownBlockContext = createContext<{ key: string; scope: string; source: string; allowWideBlocks: boolean; streaming: boolean; root: { current: HTMLDivElement | null }; views: MarkdownViewState }>({ key: "", scope: "", source: "", allowWideBlocks: false, streaming: false, root: { current: null }, views: new MarkdownViewState() });
type SyntaxNode = NonNullable<ReturnType<typeof highlightCode>["tree"]>["children"][number];
type Element = NonNullable<ExtraProps["node"]>;
/** No raw-HTML plugin: CommonMark HTML is displayed literally, never executed. */
export function MarkdownText({ text, blockKey, allowWideBlocks = false, streaming = false }: { text: string; blockKey: string; allowWideBlocks?: boolean; streaming?: boolean }) {
  const parent = useContext(TranscriptMarkdownContext), root = useRef<HTMLDivElement>(null);
  const localViews = useMemo(() => new MarkdownViewState(), []);
  const scope = markdownScope(blockKey);
  const value = useMemo(() => ({ key: blockKey, scope, source: text, allowWideBlocks, streaming, root, views: parent.views ?? localViews }), [blockKey, scope, text, allowWideBlocks, streaming, parent.views, localViews]);
  return <MarkdownBlockContext value={value}><div className="transcript-markdown" dir="auto" ref={root} onCopy={event => {
      const payload = transcriptMarkdownSelection(event.currentTarget);
      if (!payload) return;
      event.clipboardData.setData("text/plain", payload.plainText); event.clipboardData.setData("text/html", payload.htmlText);
      event.preventDefault(); event.stopPropagation();
    }}>
    <Markdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: scope }} components={components} urlTransform={(url, key) => key === "href" || key === "src" ? url : undefined}>{text}</Markdown>
  </div></MarkdownBlockContext>;
}
function syntax(nodes: SyntaxNode[], prefix = ""): ReactNode[] {
  return nodes.map((node, index) => node.type === "text" ? node.value : node.type === "element" ? <span key={`${prefix}${index}`} className={Array.isArray(node.properties.className) ? node.properties.className.filter(value => typeof value === "string" && /^hljs-|^[a-z][a-z_]*$/.test(value)).join(" ") : undefined}>{syntax(node.children, `${prefix}${index}.`)}</span> : null);
}
export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  return <SelectableCode text={code}>{highlighted.kind === "highlighted" ? syntax(highlighted.tree.children) : code}</SelectableCode>;
}
function textOf(node: Element["children"][number]): string { return node.type === "text" ? node.value : node.type === "element" ? node.children.map(textOf).join("") : ""; }
function CodeBlock({ node }: ExtraProps) {
  const context = useContext(MarkdownBlockContext), [, redraw] = useState(0), element = useRef<HTMLDivElement>(null);
  const codeNode = node?.children.find(child => child.type === "element" && child.tagName === "code");
  const classes = codeNode?.type === "element" && Array.isArray(codeNode.properties.className) ? codeNode.properties.className : [];
  const language = String(classes.find(value => typeof value === "string" && value.startsWith("language-")) ?? "").slice(9);
  // mdast-to-hast appends exactly one presentation newline to nonempty code.
  const displayed = codeNode ? textOf(codeNode) : "", code = displayed.endsWith("\n") ? displayed.slice(0, -1) : displayed;
  const key = `${context.key}:code:${node?.position?.start.offset ?? 0}`, wrapped = context.views.wrapped(key);
  const raw = context.source.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? 0);
  const open = context.streaming && codeFenceOpen(raw, code), title = codeLanguageLabel(language);
  const {highlighted, tail} = useCodeHighlight(code, open && !language ? "plaintext" : language, element);
  const copy = useCodeCopy(code), copyLabel = copy.state === "copied" ? "Copied" : copy.state === "failed" ? "Copy failed · retry" : "Copy code";
  const wrapLabel = wrapped ? "Disable word wrap" : "Enable word wrap";
  const tokens = useMemo(() => highlighted.kind === "highlighted" ? syntax(highlighted.tree.children) : null, [highlighted]);
  return <div ref={element} className="markdown-code-block" data-code-key={key} data-code-open={open} data-highlighted={highlighted.kind === "highlighted"} data-markdown-copy="code-block">
    <div className="markdown-code-toolbar" data-markdown-copy="exclude">{title && <TranscriptCodeIcon name="language_marker"/>}<span className="markdown-code-language">{title}</span><div>
      <button type="button" aria-label={wrapLabel} title={wrapLabel} aria-pressed={wrapped} onClick={() => { context.views.setWrapped(key, !wrapped); redraw(value => value + 1); }}><TranscriptCodeIcon name={wrapped ? "wrap_on" : "wrap_off"}/></button>
      {!open && <button type="button" className="markdown-code-copy" aria-label={copyLabel} title={copyLabel} aria-busy={copy.state === "pending"} disabled={copy.state === "pending"} onClick={() => void copy.copy()}><TranscriptCodeIcon name={copy.state === "copied" ? "copied" : "copy"}/></button>}
    </div></div>
    <pre className={wrapped ? "wrapped" : undefined} tabIndex={0} aria-label={`${title || "Plain text"} code`} onCopy={event => {
      const selection = event.currentTarget.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
      event.clipboardData.setData("text/plain", selection.toString()); event.preventDefault(); event.stopPropagation();
    }}><SelectableCode text={code}>{tokens ? <>{tokens}{tail}</> : code}</SelectableCode></pre>
    {copy.error && <p className="markdown-code-copy-error" role="alert" data-markdown-copy="exclude">{copy.error} <button type="button" onClick={() => void copy.copy()}>Retry</button></p>}
  </div>;
}
function MarkdownLink({ href, children, node: _node, ...props }: React.ComponentProps<"a"> & ExtraProps) {
  const { actions } = useContext(TranscriptMarkdownContext), context = useContext(MarkdownBlockContext);
  const [error, setError] = useState<string>();
  const link = resolveTranscriptLink(href ?? "", actions?.cwd, true);
  const describedBy = props["aria-describedby"]?.replace(/\bfootnote-label\b/g, `${context.scope}footnote-label`);
  async function open() {
    setError(undefined);
    try {
      if (link.kind === "external") { if (!actions?.openExternal) throw new Error("The desktop browser opener is unavailable."); await actions.openExternal(link.url); }
      else if (link.kind === "file") { if (!actions?.openFile) throw new Error("The owning workspace is unavailable."); await actions.openFile(link.file); }
      else if (link.kind === "fragment") {
        const root = context.root.current;
        const target = root?.ownerDocument.getElementById(link.id) ?? root?.ownerDocument.getElementById(decodeURIComponent(link.id));
        if (!target || !root?.contains(target)) throw new Error("This anchor is unavailable in this message.");
        if (!target.matches("a[href],button,input,select,textarea,[tabindex]")) target.tabIndex = -1;
        target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const content = link.kind === "unavailable" ? <span className="markdown-unavailable-link" title={link.reason}>{children}<span className="sr-only"> ({link.reason})</span></span>
    : link.kind === "file" ? <FileReferenceControl key={`${actions?.ownerKey ?? actions?.cwd}:${href}`} file={link.file} title={`${link.file.path}${link.file.line ? `:${link.file.line}${link.file.column ? `:${link.file.column}` : ""}${link.file.endLine ? `-${link.file.endLine}` : ""}` : ""}`}>{children}</FileReferenceControl>
    : <a {...props} aria-describedby={describedBy} href={link.kind === "external" ? link.url : `#${link.id}`} rel="noreferrer noopener" onClick={event => { event.preventDefault(); void open(); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(); }}>{children}</a>;
  return <>{content}{error && <span className="markdown-link-error" role="alert">{error}</span>}</>;
}
const unownedImage = createTranscriptImageResolver({}, undefined, () => false);
function MarkdownImage({ src, alt, title }: React.ComponentProps<"img">) {
  const { actions } = useContext(TranscriptMarkdownContext), context = useContext(MarkdownBlockContext);
  const resolver = useRef(actions?.images?.resolve ?? unownedImage);
  resolver.current = actions?.images?.resolve ?? unownedImage;
  const href = typeof src === "string" ? src : "";
  // App action objects may change during streaming; an unchanged image retains its decoded lease.
  const presentation = useMemo(() => resolver.current(href), [href, actions?.images?.ownerKey]);
  return <TranscriptMarkdownImage {...presentation} alt={alt ?? ""} title={title} rootRef={context.root}/>;
}
const components: Components = {
  pre: CodeBlock,
  a: MarkdownLink,
  img: MarkdownImage,
  table: function Table({ children, node }) {
    const context = useContext(MarkdownBlockContext);
    const start = node?.position?.start.offset, end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? context.source.slice(start, end).trim() : "";
    return <TranscriptMarkdownTable key={`${context.key}:table:${start ?? 0}`} markdownSource={source} allowWideBlocks={context.allowWideBlocks}>{children}</TranscriptMarkdownTable>;
  },
  td: ({ node, ...props }) => <td {...props} data-numeric={node && /^\d+$/.test(node.children.map(textOf).join("")) ? "" : undefined}/> ,
  h2: function Heading({ node: _node, id, ...props }) { const { scope } = useContext(MarkdownBlockContext); return <h2 {...props} id={id === "footnote-label" ? `${scope}footnote-label` : id}/>; },
};
