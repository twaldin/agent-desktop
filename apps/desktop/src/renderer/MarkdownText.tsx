import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { markdownScope, MarkdownViewState } from "./markdown-state";
import { resolveTranscriptLink, type TranscriptLinkActions } from "./transcript-links";
import { SelectableCode } from "./code-selection";
import "./markdown.css";

export const TranscriptMarkdownContext = createContext<{ actions?: TranscriptLinkActions; views?: MarkdownViewState }>({});
const MarkdownBlockContext = createContext<{ key: string; scope: string; root: { current: HTMLDivElement | null }; views: MarkdownViewState }>({ key: "", scope: "", root: { current: null }, views: new MarkdownViewState() });
const grammars = createLowlight(common);
export const HIGHLIGHT_LIMIT = 100_000;
type SyntaxNode = ReturnType<typeof grammars.highlight>["children"][number];
type Element = NonNullable<ExtraProps["node"]>;
export function highlightCode(code: string, language: string) {
  if (!language || ["text", "txt", "plaintext"].includes(language)) return { kind: "plain" as const, reason: undefined };
  if (!grammars.registered(language)) return { kind: "plain" as const, reason: "No registered grammar for this language" };
  if (code.length > HIGHLIGHT_LIMIT) return { kind: "plain" as const, reason: "Large block displayed without highlighting" };
  try { return { kind: "highlighted" as const, tree: grammars.highlight(language, code) }; }
  catch { return { kind: "plain" as const, reason: "The language grammar could not highlight this block" }; }
}
/** No raw-HTML plugin: CommonMark HTML is displayed literally, never executed. */
export function MarkdownText({ text, blockKey }: { text: string; blockKey: string }) {
  const parent = useContext(TranscriptMarkdownContext), root = useRef<HTMLDivElement>(null);
  const localViews = useMemo(() => new MarkdownViewState(), []);
  const scope = markdownScope(blockKey);
  const value = useMemo(() => ({ key: blockKey, scope, root, views: parent.views ?? localViews }), [blockKey, scope, parent.views, localViews]);
  return <MarkdownBlockContext value={value}><div className="transcript-markdown" dir="auto" ref={root}>
    <Markdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: scope }} components={components} urlTransform={(url, key) => key === "href" ? url : undefined}>{text}</Markdown>
  </div></MarkdownBlockContext>;
}
function syntax(nodes: SyntaxNode[], prefix = ""): ReactNode[] {
  return nodes.map((node, index) => node.type === "text" ? node.value : node.type === "element" ? <span key={`${prefix}${index}`} className={Array.isArray(node.properties.className) ? node.properties.className.filter(value => typeof value === "string" && /^hljs-|^[a-z][a-z_]*$/.test(value)).join(" ") : undefined}>{syntax(node.children, `${prefix}${index}.`)}</span> : null);
}
function textOf(node: Element["children"][number]): string { return node.type === "text" ? node.value : node.type === "element" ? node.children.map(textOf).join("") : ""; }
function CodeBlock({ node }: ExtraProps) {
  const context = useContext(MarkdownBlockContext), [, redraw] = useState(0);
  const [copy, setCopy] = useState<{ text: string; status: "copied" | "failed" }>();
  const codeNode = node?.children.find(child => child.type === "element" && child.tagName === "code");
  const classes = codeNode?.type === "element" && Array.isArray(codeNode.properties.className) ? codeNode.properties.className : [];
  const language = String(classes.find(value => typeof value === "string" && value.startsWith("language-")) ?? "").slice(9).toLowerCase();
  // mdast-to-hast appends exactly one presentation newline to nonempty code.
  const displayed = codeNode ? textOf(codeNode) : "", code = displayed.endsWith("\n") ? displayed.slice(0, -1) : displayed;
  const key = `${context.key}:code:${node?.position?.start.offset ?? 0}`, wrapped = context.views.wrapped(key);
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  return <div className="markdown-code-block" data-code-key={key} data-highlighted={highlighted.kind === "highlighted"}>
    <div className="markdown-code-toolbar"><span className="markdown-code-language" title={highlighted.kind === "plain" ? highlighted.reason : undefined}>{language || "Text"}{highlighted.kind === "plain" && highlighted.reason ? " · plain text" : ""}</span><div>
      <button type="button" aria-label="Wrap code lines" aria-pressed={wrapped} onClick={() => { context.views.setWrapped(key, !wrapped); redraw(value => value + 1); }}>Wrap</button>
      <button type="button" aria-label="Copy code" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopy({ text: code, status: "copied" }); } catch { setCopy({ text: code, status: "failed" }); } }}><span aria-live="polite">{copy?.text === code ? copy.status === "copied" ? "Copied" : "Copy failed · retry" : "Copy"}</span></button>
    </div></div>
    <pre className={wrapped ? "wrapped" : undefined} tabIndex={0} aria-label={`${language || "Plain text"} code`}><SelectableCode text={code}>{highlighted.kind === "highlighted" ? syntax(highlighted.tree.children) : code}</SelectableCode></pre>
  </div>;
}
function MarkdownLink({ href, children, node: _node, ...props }: React.ComponentProps<"a"> & ExtraProps) {
  const { actions } = useContext(TranscriptMarkdownContext), context = useContext(MarkdownBlockContext);
  const [error, setError] = useState<string>();
  const link = resolveTranscriptLink(href ?? "", actions?.cwd);
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
    : link.kind === "file" ? <button type="button" className="markdown-file-link" title={`Open ${link.file.path}${link.file.line ? `:${link.file.line}` : ""} on the session’s host`} onClick={() => void open()}>{children}</button>
    : <a {...props} aria-describedby={describedBy} href={link.kind === "external" ? link.url : `#${link.id}`} rel="noreferrer noopener" onClick={event => { event.preventDefault(); void open(); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(); }}>{children}</a>;
  return <>{content}{error && <span className="markdown-link-error" role="alert">{error}</span>}</>;
}
const components: Components = {
  pre: CodeBlock,
  a: MarkdownLink,
  img: ({ alt }) => <span className="markdown-image-placeholder">Image{alt ? `: ${alt}` : ""} (attachments are not available in this build)</span>,
  table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="Markdown table" tabIndex={0}><table>{children}</table></div>,
  h2: function Heading({ node: _node, id, ...props }) { const { scope } = useContext(MarkdownBlockContext); return <h2 {...props} id={id === "footnote-label" ? `${scope}footnote-label` : id}/>; },
};
