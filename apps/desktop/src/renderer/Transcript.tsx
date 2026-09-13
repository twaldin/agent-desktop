import { ComposerSelectedText } from "./ComposerSelectedText";
import { TranscriptFileMentions } from "./TranscriptFileMentions";
import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { McpArtifact, TranscriptBlock, TranscriptMessage } from "../../../../packages/shared/src/protocol";
import { Icon } from "./Icons";
import { GoalIcon } from "./GoalIcons";
import { goalDuration, goalCompletionTitle, messageBlocks, toolLinks, toolOutcome, TranscriptDisclosureState, type ToolLink } from "./transcript-state";
import "./transcript.css";
import { MarkdownText, TranscriptCode, TranscriptMarkdownContext } from "./MarkdownText";
import { MarkdownViewState } from "./markdown-state";
import type { TranscriptLinkActions } from "./transcript-links";
import { ImagePreview } from "./ImagePreview";
import type { AttachmentMediaContext } from "./attachment-media";

export interface TranscriptImages { media: AttachmentMediaContext; hostId: string; sessionId: string }
const ImageContext = createContext<TranscriptImages | undefined>(undefined);
const ArtifactContext = createContext<((artifact: McpArtifact) => void) | undefined>(undefined);

export function TranscriptMessages({ messages, contextKey, connected, linkActions, images, onOpenArtifact }: { messages: TranscriptMessage[]; contextKey: string; connected: boolean; linkActions?: TranscriptLinkActions; images?: TranscriptImages; onOpenArtifact?(artifact: McpArtifact): void }) {
  const disclosures = useMemo(() => new TranscriptDisclosureState(), [contextKey]);
  const markdownViews = useMemo(() => new MarkdownViewState(), [contextKey]);
  const links = useMemo(() => toolLinks(messages), [messages]);
  return <ArtifactContext value={onOpenArtifact}><ImageContext value={images}><TranscriptMarkdownContext value={{ actions: linkActions, views: markdownViews }}>{messages.map(message => <TranscriptItem key={message.id} message={message} connected={connected} disclosures={disclosures} calls={links.calls} linkedCall={links.results.get(message.id)}/>)}</TranscriptMarkdownContext></ImageContext></ArtifactContext>;
}
export function TranscriptItem({ message, connected, disclosures, calls, linkedCall }: { message: TranscriptMessage; connected: boolean; disclosures: TranscriptDisclosureState; calls: Map<string, ToolLink>; linkedCall?: ToolLink }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const images = useContext(ImageContext);
  const openArtifact = useContext(ArtifactContext);
  const blocks = messageBlocks(message);
  if (message.role === "fileMention" && message.fileReferences) return <TranscriptFileMentions message={message} images={images} connected={connected}/>;
  const renderBlock = (block: TranscriptBlock, index: number) => <Block key={index} block={block} blockKey={`${message.id}:block:${index}`} nativeEntryId={message.nativeId} disclosures={disclosures} calls={calls} connected={connected} streaming={message.lifecycle === "streaming" || message.tool?.status === "running"} allowWideBlocks={message.role === "assistant" || message.role === "user"} toolOutput={message.role === "toolResult" || message.role === "tool"}/>;
  if (message.role === "toolResult" || message.role === "tool") {
    const outcome = toolOutcome(message, connected), name = message.tool?.name ?? linkedCall?.call.name ?? "Tool";
    return <div className="transcript-tool-result" data-message-id={message.id} data-native-id={message.nativeId}>
      {message.mcpArtifact && <button className="transcript-artifact-open" disabled={!connected || !openArtifact} onClick={() => openArtifact?.(message.mcpArtifact!)}>Open {message.mcpArtifact.toolName} result</button>}
      {message.mcpArtifactError && <p role="status">{message.mcpArtifactError}</p>}
      <Disclosure state={disclosures} stateKey={message.id} running={outcome.tone === "running"} label={`${name} result`} icon={toolIcon(name)} tone={outcome.tone} status={outcome.label}>
        {linkedCall && <a className="transcript-call-reference" href={`#${encodeURIComponent(callAnchor(linkedCall.key))}`}>View {name} invocation</a>}
        {message.tool?.output && <OutputProvenance message={message} disclosures={disclosures}/>}
        {blocks.length ? blocks.map(renderBlock) : <p className="transcript-empty-output">{message.tool?.isError ? "The tool failed without output." : message.tool?.status === "completed" ? "No output was returned." : "No output has been received."}</p>}
      </Disclosure>
    </div>;
  }
  if (message.role === "commandOutput" && message.commandOutput) return <details className="transcript-command-output" data-message-id={message.id} data-native-id={message.commandOutput.entryId} open>
    <summary><Icon name="terminal"/><span>/{message.commandOutput.command.replace(/^\//, "")}</span><span className="transcript-command-origin">Command output</span></summary>
    <pre className="transcript-output-text">{message.commandOutput.output}</pre>
  </details>;
  if (message.role === "selectedText" && message.selectedText) return <section className="transcript-selected-context" data-message-id={message.id} data-native-id={message.nativeId} aria-label="Saved selected text">
    <ComposerSelectedText attachments={message.selectedText.attachments}/><span className="transcript-selected-context-status">Saved context · prompt not linked</span>
  </section>;
  const user = message.role === "user", assistant = message.role === "assistant";
  if (!user && !assistant) return <section className="transcript-native-message" data-message-id={message.id} aria-label={`Native ${message.role} message`}><div className="transcript-native-role">{message.role}</div>{blocks.map(renderBlock)}{!blocks.length && <p className="subtle-notice">No displayable content was supplied for this native message.</p>}</section>;
  const metadata = message.assistant, complete = message.lifecycle === "complete", goalCompletion = assistant ? message.goalCompletion : undefined;
  const showBody = !user || !message.selectedText || blocks.some(block => block.type !== "text" || block.text.length > 0);
  return <article className={`message ${user ? `user-message${message.selectedText ? " has-selected-text" : ""}` : "assistant-message"}`} data-message-id={message.id} data-native-id={message.nativeId} aria-label={user ? "Your message" : "Assistant message"}>
    {user && message.selectedText && <div className="transcript-user-attachments"><ComposerSelectedText attachments={message.selectedText.attachments}/></div>}
    {showBody && <div className="message-body">{blocks.map(renderBlock)}
      {complete && metadata?.stopReason === "error" && <p className="transcript-message-error" role="status">{metadata.errorMessage || "The provider ended this response with an error."}</p>}
      {complete && metadata?.stopReason === "aborted" && <p className="transcript-message-notice" role="status">{metadata.errorMessage || "This response was interrupted."}</p>}
      {complete && metadata?.stopReason === "length" && <p className="transcript-message-notice">The response reached its output limit.</p>}
    </div>}
    {assistant && <div className="transcript-message-actions">{message.text && <button className="copy-message" onClick={async () => { try { await navigator.clipboard.writeText(message.text); setCopyState("copied"); } catch { setCopyState("failed"); } }}><span aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed · retry" : "Copy"}</span></button>}{goalCompletion && <span className="transcript-goal-achievement" title={goalCompletionTitle(goalCompletion)}><GoalIcon name="achieved"/><span>Goal achieved in {goalDuration(goalCompletion.timeUsedSeconds)}</span></span>}{metadata && Object.keys(metadata).length > 0 && <details className="transcript-message-metadata"><summary>Response details</summary><dl>{metadata.provider && <><dt>Provider</dt><dd>{metadata.provider}</dd></>}{metadata.model && <><dt>Model</dt><dd>{metadata.model}</dd></>}{metadata.upstreamProvider && <><dt>Upstream provider</dt><dd>{metadata.upstreamProvider}</dd></>}{metadata.upstreamModel && <><dt>Upstream model</dt><dd>{metadata.upstreamModel}</dd></>}{complete && metadata.stopReason && <><dt>Native stop reason</dt><dd>{metadata.stopReason}</dd></>}{metadata.durationMs !== undefined && <><dt>Native duration</dt><dd>{metadata.durationMs} ms</dd></>}{metadata.usage && <><dt>Reported usage</dt><dd><pre>{JSON.stringify(metadata.usage, null, 2)}</pre></dd></>}</dl></details>}</div>}
  </article>;
}
function Block({ block, blockKey, nativeEntryId, disclosures, calls, connected, allowWideBlocks = false, streaming = false, toolOutput = false }: { block: TranscriptBlock; blockKey: string; nativeEntryId?: string; disclosures: TranscriptDisclosureState; calls: Map<string, ToolLink>; connected: boolean; allowWideBlocks?: boolean; streaming?: boolean; toolOutput?: boolean }) {
  const images = useContext(ImageContext);
  if (block.type === "image") return images && nativeEntryId
    ? <ImagePreview media={images.media} source={{ kind: "transcript", sessionId: images.sessionId, nativeEntryId, blockIndex: block.blockIndex, mimeType: block.mimeType, bytes: block.bytes, sha256: block.sha256 }} hostId={images.hostId} connected={connected} label="Recorded image" className="transcript-image"/>
    : <p className="subtle-notice">{nativeEntryId ? "Image preview is unavailable in this view." : "This image does not yet have a saved native entry."}</p>;
  if (block.type === "text") return toolOutput ? <TranscriptCode code={block.text} blockKey={blockKey} output open={streaming} title={streaming ? "Output so far" : "Output"}/> : <MarkdownText text={block.text} blockKey={blockKey} allowWideBlocks={allowWideBlocks} streaming={streaming}/>;
  if (block.type === "thinking") return <Disclosure state={disclosures} stateKey={blockKey} label="Thinking" variant="thinking"><MarkdownText text={block.thinking} blockKey={blockKey} streaming={streaming}/></Disclosure>;
  if (block.type === "toolCall") {
    const link = calls.get(blockKey), outcome = toolOutcome(link?.result, connected);
    return <div id={callAnchor(blockKey)} className="transcript-tool-invocation"><Disclosure state={disclosures} stateKey={blockKey} label={block.intent || block.name} icon={toolIcon(block.name)} status={outcome.label} tone={outcome.tone} running={outcome.tone === "running"}><p className="transcript-tool-name">{block.name}</p><TranscriptCode code={JSON.stringify(block.arguments, null, 2)} language="json" blockKey={`${blockKey}:arguments`} output title="Arguments" copyAction="Copy arguments"/></Disclosure></div>;
  }
  return <p className="subtle-notice transcript-unsupported">{block.nativeType === "redactedThinking" ? "The provider withheld this reasoning content." : `This build cannot display native ${block.nativeType} content${block.mimeType ? ` (${block.mimeType})` : ""}.`}</p>;
}
function OutputProvenance({ message, disclosures }: { message: TranscriptMessage; disclosures: TranscriptDisclosureState }) {
  const output = message.tool!.output!, truncation = output.truncation;
  return <div className="transcript-output-provenance">
    {truncation?.truncated && <p className="transcript-message-notice">OMP truncated this output{truncation.direction ? ` (${truncation.direction === "middle" ? "middle omitted" : truncation.direction === "head" ? "beginning shown" : "end shown"})` : ""}{truncation.partialLine ? " · the shown line is partial" : truncation.outputLines !== undefined && truncation.totalLines !== undefined ? ` · ${truncation.outputLines} of ${truncation.totalLines} lines shown` : ""}. Copy output copies only the recorded text, not omitted content.</p>}
    {output.columnTruncated !== undefined && <p className="transcript-message-notice">OMP limited output columns to {output.columnTruncated}.</p>}
    {output.summary && output.summary.elidedLines > 0 && <p className="transcript-message-notice">OMP returned a summary with {output.summary.elidedLines} lines omitted.</p>}
    {truncation?.artifactId && <p className="transcript-message-notice">Recorded full-output reference: <code>artifact://{truncation.artifactId}</code>. Retrieve it with OMP read; this view contains the recorded preview.</p>}
    <Disclosure state={disclosures} stateKey={`${message.id}:output-details`} label="Output details" variant="thinking"><TranscriptCode code={JSON.stringify(output, null, 2)} language="json" blockKey={`${message.id}:output-details`} output title="Native output metadata" copyAction="Copy output metadata"/></Disclosure>
  </div>;
}
function toolIcon(name: string): React.ComponentProps<typeof Icon>["name"] {
  switch (name) {
    case "bash": case "eval": return "terminal";
    case "read": return "projectNotebook";
    case "grep": case "glob": return "search";
    case "write": case "edit": return "pencil";
    default: return "sliders";
  }
}
function Disclosure({ state, stateKey, label, status, tone = "unknown", running = false, variant = "tool", icon = "sliders", children }: { state: TranscriptDisclosureState; stateKey: string; label: string; status?: string; tone?: string; running?: boolean; variant?: "tool" | "thinking"; icon?: React.ComponentProps<typeof Icon>["name"]; children: ReactNode }) {
  const [, redraw] = useState(0); const expanded = state.get(stateKey, running), bodyId = useId();
  return <section className={`transcript-disclosure ${variant} ${tone}`}><button type="button" className="transcript-activity-header" aria-expanded={expanded} aria-controls={bodyId} title={label} onClick={() => { state.set(stateKey, !expanded); redraw(value => value + 1); }}>{variant === "tool" && <Icon name={icon}/>}<span className="transcript-activity-label">{label}</span>{status && <span className="transcript-activity-status">{status}</span>}<Icon name="chevron" className={`transcript-activity-chevron${expanded ? " rotated" : ""}`}/></button><div id={bodyId} className="transcript-activity-body" hidden={!expanded} inert={!expanded}>{children}</div></section>;
}
function callAnchor(key: string) { return `tool-call-${key}`; }
