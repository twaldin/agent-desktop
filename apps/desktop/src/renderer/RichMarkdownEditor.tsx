import { useEffect, useMemo, useRef, useState } from "react";
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, highlightSpecialChars, drawSelection, type DecorationSet, WidgetType } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM, Superscript, Subscript, Emoji } from "@lezer/markdown";
import { applyMarkdownChanges, markdownMetadata, markdownTextChange, normalizeMarkdown, protectMarkdownPrefix } from "./markdown-file-model";
import { resolveTranscriptLink } from "./transcript-links";
import "./rich-markdown-editor.css";

const focusChanged = StateEffect.define<boolean>();
const externalText = Annotation.define<boolean>();
const protectMetadata = EditorState.transactionFilter.of(transaction => {
  const metadata = markdownMetadata(transaction.startState.doc.toString());
  if (!metadata || !transaction.docChanged || transaction.annotation(externalText)) return transaction;
  const changes: {from:number;to:number;insert:string}[] = [];
  transaction.changes.iterChanges((from,to,_fromB,_toB,insert)=>changes.push({from,to,insert:insert.toString()}));
  if (changes.every(change=>change.from>=metadata.end)) return transaction;
  const protectedChanges=protectMarkdownPrefix(changes,metadata.end);
  if (!protectedChanges.length) return [];
  const mapped=transaction.startState.changes(protectedChanges);
  const last=protectedChanges.at(-1)!;
  return {changes:mapped,selection:EditorSelection.cursor(mapped.mapPos(last.from,-1)+last.insert.length),
    effects:transaction.effects,scrollIntoView:transaction.scrollIntoView,
    annotations:[Transaction.userEvent.of(transaction.annotation(Transaction.userEvent)??"input"),Transaction.addToHistory.of(transaction.annotation(Transaction.addToHistory)??true)]};
});
const focused = StateField.define({ create: () => false, update: (value, transaction) => {
  for (const effect of transaction.effects) if (effect.is(focusChanged)) return effect.value;
  return value;
} });
class HiddenMetadata extends WidgetType {
  toDOM() { const node = document.createElement("div"); node.className = "markdown-hidden-metadata"; node.setAttribute("aria-hidden", "true"); return node; }
}
class Bullet extends WidgetType {
  toDOM() { const node = document.createElement("span"); node.textContent = "•"; node.className = "markdown-bullet"; return node; }
}
class TaskCheckbox extends WidgetType {
  constructor(readonly checked: boolean, readonly position: number, readonly readOnly: boolean) { super(); }
  eq(other: TaskCheckbox) { return this.checked === other.checked && this.position === other.position && this.readOnly === other.readOnly; }
  toDOM(view: EditorView) {
    const node = document.createElement("input"); node.type = "checkbox"; node.checked = this.checked; node.disabled = this.readOnly;
    node.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    node.dataset.markdownTask = String(this.position); node.className = "markdown-task-checkbox";
    // Keep the pointer from moving the CM selection onto (and revealing) the
    // marker before the browser can finish this checkbox click.
    node.addEventListener("mousedown", event => event.preventDefault());
    node.addEventListener("click", event => {
      event.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.position, to: this.position + 1, insert: this.checked ? " " : "x" }, userEvent: "input" });
    });
    return node;
  }
  ignoreEvent() { return true; }
}

function richDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [], doc = state.doc;
  const metadata = markdownMetadata(doc.toString());
  if (metadata) {
    // Leave the final newline outside the block replacement. Including it also
    // swallows line decorations on the first heading after the metadata.
    const end = metadata.end - (doc.sliceString(metadata.end - 1, metadata.end) === "\n" ? 1 : 0);
    decorations.push(Decoration.replace({ widget: new HiddenMetadata(), block: true }).range(0, end));
  }
  const selected = (from: number, to: number) => state.field(focused) && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const hide = (from: number, to: number) => { if (to > from) decorations.push(Decoration.replace({}).range(from, to)); };
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (to > from) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const lines = (from: number, to: number, className: string) => {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
      const line = doc.line(number); decorations.push(Decoration.line({ class: className }).range(line.from));
    }
  };
  syntaxTree(state).iterate({ enter(node) {
    const { from, to, name } = node;
    if (metadata && from < metadata.end && name !== "Document") return false;
    const parent = node.node.parent;
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(name)) lines(from, to, `markdown-heading markdown-h${name.at(-1)}`);
    if (name === "StrongEmphasis") mark(from, to, "markdown-strong");
    if (name === "Emphasis") mark(from, to, "markdown-emphasis");
    if (name === "Strikethrough") mark(from, to, "markdown-strike");
    if (name === "Superscript") mark(from, to, "markdown-superscript");
    if (name === "Subscript") mark(from, to, "markdown-subscript");
    if (name === "InlineCode") mark(from, to, "markdown-inline-code");
    if (name === "Blockquote") lines(from, to, "markdown-quote");
    if (name === "FencedCode" || name === "CodeBlock") { lines(from, to, "markdown-code-line"); }
    if (name === "Table") lines(from, to, "markdown-table-line");
    if (name === "TableHeader") mark(from, to, "markdown-strong");
    if (name === "HorizontalRule" && !selected(from, to)) {
      lines(from, to, "markdown-horizontal-rule"); hide(from, to); return false;
    }
    if (name === "HeaderMark" && !selected(from, to)) {
      hide(from, Math.min(to + (doc.sliceString(to, to + 1) === " " ? 1 : 0), doc.length));
    }
    if (["EmphasisMark", "StrikethroughMark", "SuperscriptMark", "SubscriptMark", "CodeMark"].includes(name)
      && parent?.name !== "FencedCode" && parent && !selected(parent.from, parent.to)) hide(from, to);
    if (name === "QuoteMark" && !selected(from, to)) hide(from, to);
    if (name === "ListMark" && /^[*+-]$/.test(doc.sliceString(from, to)) && !selected(from, to))
      decorations.push(Decoration.replace({ widget: new Bullet() }).range(from, to));
    if (name === "TaskMarker" && !selected(from, to))
      decorations.push(Decoration.replace({ widget: new TaskCheckbox(doc.sliceString(from + 1, from + 2).toLowerCase() === "x", from + 1, state.readOnly) }).range(from, to));
    if (name === "Link") {
      const urlNode = node.node.getChild("URL"), marks = node.node.getChildren("LinkMark");
      if (urlNode && marks.length === 4) {
        const href = doc.sliceString(urlNode.from, urlNode.to).replace(/^<|>$/g, "");
        const target = resolveTranscriptLink(href);
        if (target.kind === "external" && !selected(from, to)) {
          mark(marks[0]!.to, marks[1]!.from, "markdown-edit-link", { "data-markdown-href": target.url });
          hide(from, marks[0]!.to); hide(marks[1]!.from, to); return false;
        }
      }
    }
  } });
  return Decoration.set(decorations, true);
}
const decorations = StateField.define<DecorationSet>({ create: richDecorations, update: (_value, transaction) => richDecorations(transaction.state),
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field).update({ filter: (_from, _to, value) => Boolean(value.spec.widget) }))],
});

export interface RichMarkdownEditorProps {
  documentKey: string; value: string; label: string; onChange(text: string): void; onSave(): void;
  readOnly?: boolean; active?: boolean; openExternal?(url: string): Promise<void>;
}
/** Formatting is a view over Markdown, never an HTML-to-Markdown round trip. */
export function RichMarkdownEditor(props: RichMarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), latest = useRef(props);
  latest.current = props;
  const raw = useRef(props.value), baseline = useRef(props.value), writable = useRef(new Compartment());
  const alive = useRef(false);
  const [expanded, setExpanded] = useState(false), [linkError, setLinkError] = useState<string>();
  const metadata = useMemo(() => markdownMetadata(normalizeMarkdown(props.value)), [props.value]);
  useEffect(() => {
    alive.current = true; setLinkError(undefined); setExpanded(false);
    raw.current = baseline.current = latest.current.value;
    const initial=normalizeMarkdown(raw.current);
    const editor = new EditorView({ parent: container.current!, state: EditorState.create({ doc: initial, selection: {anchor:markdownMetadata(initial)?.end??0}, extensions: [
      protectMetadata,
      focused, markdown({ extensions: [...GFM, Superscript, Subscript, Emoji], completeHTMLTags: false }),
      history(), drawSelection(), highlightSpecialChars(), highlightSelectionMatches(),
      writable.current.of([EditorState.readOnly.of(Boolean(latest.current.readOnly)), EditorView.editable.of(!latest.current.readOnly)]),
      EditorView.contentAttributes.of({ "aria-label": props.label, "aria-multiline": "true", spellcheck: "false" }),
      keymap.of([{ key: "Mod-s", run: () => { if (!latest.current.readOnly) latest.current.onSave(); return true; } },
        {key:"Mod-a",run:editor=>{const from=markdownMetadata(editor.state.doc.toString())?.end??0;editor.dispatch({selection:{anchor:from,head:editor.state.doc.length},userEvent:"select"});return true;}},
        ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      placeholder("Write in Markdown…"), EditorView.lineWrapping, decorations,
      EditorView.domEventHandlers({
        focus: (_event, editor) => { editor.dispatch({ effects: focusChanged.of(true) }); },
        blur: (_event, editor) => { editor.dispatch({ effects: focusChanged.of(false) }); },
        mousedown: (event) => {
          const link = (event.target as HTMLElement).closest<HTMLElement>("[data-markdown-href]");
          if (!link || event.button !== 0 || !latest.current.openExternal) return false;
          event.preventDefault(); setLinkError(undefined);
          const identity=latest.current.documentKey;
          void latest.current.openExternal(link.dataset.markdownHref!).catch(error => {
            if(alive.current&&latest.current.documentKey===identity)setLinkError(error instanceof Error ? error.message : "Could not open link");
          });
          return true;
        },
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || update.transactions.every(transaction => transaction.annotation(Transaction.addToHistory) === false)) return;
        const changes: { from: number; to: number; insert: string }[] = [];
        update.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() }));
        const normalized = update.state.doc.toString();
        raw.current = normalized === normalizeMarkdown(baseline.current) ? baseline.current : applyMarkdownChanges(raw.current, changes);
        latest.current.onChange(raw.current);
      }),
    ] }) });
    view.current = editor;
    return () => { alive.current=false; editor.destroy(); view.current = null; };
  }, [props.documentKey]);
  useEffect(() => {
    const editor = view.current; if (!editor || props.value === raw.current) return;
    raw.current = baseline.current = props.value;
    const value = normalizeMarkdown(props.value);
    if (editor.state.doc.toString() !== value) editor.dispatch({ changes: markdownTextChange(editor.state.doc.toString(),value), annotations: [Transaction.addToHistory.of(false),externalText.of(true)] });
  }, [props.value]);
  useEffect(() => { view.current?.dispatch({ effects: writable.current.reconfigure([EditorState.readOnly.of(Boolean(props.readOnly)), EditorView.editable.of(!props.readOnly)]) }); }, [props.readOnly]);
  useEffect(() => { if (props.active !== false) view.current?.requestMeasure(); }, [props.active]);
  return <div className="rich-markdown-file" hidden={props.active === false}>
    {metadata && <section className="markdown-file-metadata" aria-label="Metadata"><h3>Metadata</h3><dl>
      {(expanded ? metadata.entries : metadata.entries.slice(0, 8)).map(entry => <div key={entry.key}><dt>{entry.key}</dt><dd>{Array.isArray(entry.value)
        ? entry.value.map((value, index) => <span className="markdown-metadata-pill" key={index}>{value}</span>) : entry.value}</dd></div>)}
    </dl>{metadata.entries.length > 8 && <button onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button>}</section>}
    {linkError && <p role="alert">{linkError}</p>}
    <div ref={container} className="rich-markdown-content"/>
  </div>;
}
