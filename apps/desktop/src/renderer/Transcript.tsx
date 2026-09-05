import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { TranscriptBlock, TranscriptMessage } from "../../../../packages/shared/src/protocol";
import { Icon } from "./Icons";
import { messageBlocks, toolLinks, toolOutcome, TranscriptDisclosureState, type ToolLink } from "./transcript-state";
import "./transcript.css";
import { MarkdownText, TranscriptMarkdownContext } from "./MarkdownText";
import { MarkdownViewState } from "./markdown-state";
import type { TranscriptLinkActions } from "./transcript-links";
import { ImagePreview } from "./ImagePreview";
import type { AttachmentMediaContext } from "./attachment-media";

export interface TranscriptImages { media: AttachmentMediaContext; hostId: string; sessionId: string }
const ImageContext = createContext<TranscriptImages | undefined>(undefined);

export function TranscriptMessages({ messages, contextKey, connected, linkActions, images }: { messages: TranscriptMessage[]; contextKey: string; connected: boolean; linkActions?: TranscriptLinkActions; images?: TranscriptImages }) {
  const disclosures = useMemo(() => new TranscriptDisclosureState(), [contextKey]);
  const markdownViews = useMemo(() => new MarkdownViewState(), [contextKey]);
  const links = useMemo(() => toolLinks(messages), [messages]);
  return <ImageContext value={images}><TranscriptMarkdownContext value={{ actions: linkActions, views: markdownViews }}>{messages.map(message => <TranscriptItem key={message.id} message={message} connected={connected} disclosures={disclosures} calls={links.calls} linkedCall={links.results.get(message.id)}/>)}</TranscriptMarkdownContext></ImageContext>;
}
export function TranscriptItem({ message, connected, disclosures, calls, linkedCall }: { message: TranscriptMessage; connected: boolean; disclosures: TranscriptDisclosureState; calls: Map<string, ToolLink>; linkedCall?: ToolLink }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const blocks = messageBlocks(message);
  const renderBlock = (block: TranscriptBlock, index: number) => <Block key={index} block={block} blockKey={`${message.id}:block:${index}`} nativeEntryId={message.nativeId} disclosures={disclosures} calls={calls} connected={connected} toolOutput={message.role === "toolResult" || message.role === "tool"}/>;
  if (message.role === "toolResult" || message.role === "tool") {
    const outcome = toolOutcome(message, connected), name = message.tool?.name ?? linkedCall?.call.name ?? "Tool";
    return <div className="transcript-tool-result" data-message-id={message.id} data-native-id={message.nativeId}>
      <Disclosure state={disclosures} stateKey={message.id} running={outcome.tone === "running"} label={`${name} result`} tone={outcome.tone} status={outcome.label}>
        {linkedCall && <a className="transcript-call-reference" href={`#${encodeURIComponent(callAnchor(linkedCall.key))}`}>View {name} invocation</a>}
        {blocks.length ? blocks.map(renderBlock) : <p className="transcript-empty-output">{message.tool?.isError ? "The tool failed without output." : message.tool?.status === "completed" ? "No output was returned." : "No output has been received."}</p>}
      </Disclosure>
    </div>;
  }
  const user = message.role === "user", assistant = message.role === "assistant";
  if (!user && !assistant) return <section className="transcript-native-message" data-message-id={message.id} aria-label={`Native ${message.role} message`}><div className="transcript-native-role">{message.role}</div>{blocks.map(renderBlock)}{!blocks.length && <p className="subtle-notice">No displayable content was supplied for this native message.</p>}</section>;
  const metadata = message.assistant, complete = message.lifecycle === "complete";
  return <article className={`message ${user ? "user-message" : "assistant-message"}`} data-message-id={message.id} data-native-id={message.nativeId} aria-label={user ? "Your message" : "Assistant message"}>
    <div className="message-body">{blocks.map(renderBlock)}
      {complete && metadata?.stopReason === "error" && <p className="transcript-message-error" role="status">{metadata.errorMessage || "The provider ended this response with an error."}</p>}
      {complete && metadata?.stopReason === "aborted" && <p className="transcript-message-notice" role="status">{metadata.errorMessage || "This response was interrupted."}</p>}
      {complete && metadata?.stopReason === "length" && <p className="transcript-message-notice">The response reached its output limit.</p>}
    </div>
    {assistant && <div className="transcript-message-actions">{message.text && <button className="copy-message" onClick={async () => { try { await navigator.clipboard.writeText(message.text); setCopyState("copied"); } catch { setCopyState("failed"); } }}><span aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed · retry" : "Copy"}</span></button>}{metadata && Object.keys(metadata).length > 0 && <details className="transcript-message-metadata"><summary>Response details</summary><dl>{metadata.provider && <><dt>Provider</dt><dd>{metadata.provider}</dd></>}{metadata.model && <><dt>Model</dt><dd>{metadata.model}</dd></>}{metadata.upstreamProvider && <><dt>Upstream provider</dt><dd>{metadata.upstreamProvider}</dd></>}{metadata.upstreamModel && <><dt>Upstream model</dt><dd>{metadata.upstreamModel}</dd></>}{complete && metadata.stopReason && <><dt>Native stop reason</dt><dd>{metadata.stopReason}</dd></>}{metadata.durationMs !== undefined && <><dt>Native duration</dt><dd>{metadata.durationMs} ms</dd></>}{metadata.usage && <><dt>Reported usage</dt><dd><pre>{JSON.stringify(metadata.usage, null, 2)}</pre></dd></>}</dl></details>}</div>}
  </article>;
}
function Block({ block, blockKey, nativeEntryId, disclosures, calls, connected, toolOutput = false }: { block: TranscriptBlock; blockKey: string; nativeEntryId?: string; disclosures: TranscriptDisclosureState; calls: Map<string, ToolLink>; connected: boolean; toolOutput?: boolean }) {
  const images = useContext(ImageContext);
  if (block.type === "image") return images && nativeEntryId
    ? <ImagePreview media={images.media} source={{ kind: "transcript", sessionId: images.sessionId, nativeEntryId, blockIndex: block.blockIndex, mimeType: block.mimeType, bytes: block.bytes, sha256: block.sha256 }} hostId={images.hostId} connected={connected} label="Recorded image" className="transcript-image"/>
    : <p className="subtle-notice">{nativeEntryId ? "Image preview is unavailable in this view." : "This image does not yet have a saved native entry."}</p>;
  if (block.type === "text") return toolOutput ? <pre className="transcript-output-text">{block.text}</pre> : <MarkdownText text={block.text} blockKey={blockKey}/>;
  if (block.type === "thinking") return <Disclosure state={disclosures} stateKey={blockKey} label="Thinking" variant="thinking"><MarkdownText text={block.thinking} blockKey={blockKey}/></Disclosure>;
  if (block.type === "toolCall") {
    const link = calls.get(blockKey), outcome = toolOutcome(link?.result, connected);
    return <div id={callAnchor(blockKey)} className="transcript-tool-invocation"><Disclosure state={disclosures} stateKey={blockKey} label={block.intent || block.name} status={outcome.label} tone={outcome.tone} running={outcome.tone === "running"}><p className="transcript-tool-name">{block.name}</p><pre className="transcript-tool-arguments">{JSON.stringify(block.arguments, null, 2)}</pre></Disclosure></div>;
  }
  return <p className="subtle-notice transcript-unsupported">{block.nativeType === "redactedThinking" ? "The provider withheld this reasoning content." : `This build cannot display native ${block.nativeType} content${block.mimeType ? ` (${block.mimeType})` : ""}.`}</p>;
}
function Disclosure({ state, stateKey, label, status, tone = "unknown", running = false, variant = "tool", children }: { state: TranscriptDisclosureState; stateKey: string; label: string; status?: string; tone?: string; running?: boolean; variant?: "tool" | "thinking"; children: ReactNode }) {
  const [, redraw] = useState(0); const expanded = state.get(stateKey, running), bodyId = useId();
  return <section className={`transcript-disclosure ${variant} ${tone}`}><button type="button" className="transcript-activity-header" aria-expanded={expanded} aria-controls={bodyId} onClick={() => { state.set(stateKey, !expanded); redraw(value => value + 1); }}><Icon name="chevron" className={expanded ? "rotated" : ""}/>{variant === "tool" && <Icon name="terminal"/>}<span className="transcript-activity-label">{label}</span>{status && <span className="transcript-activity-status">{status}</span>}</button><div id={bodyId} className="transcript-activity-body" hidden={!expanded}>{children}</div></section>;
}
function callAnchor(key: string) { return `tool-call-${key}`; }
