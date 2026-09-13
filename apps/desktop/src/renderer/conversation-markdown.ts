import type { TranscriptBlock, TranscriptMessage } from "../../../../packages/shared/src/protocol";
import { messageBlocks, toolOutcome } from "./transcript-state";

export interface ConversationMarkdownOwner { hostId: string; sessionId: string }
export interface ConversationMarkdownSnapshot {
  owner: ConversationMarkdownOwner | null;
  source: "host" | "cache" | null;
  messages: readonly TranscriptMessage[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export function conversationMarkdownIssue(snapshot: ConversationMarkdownSnapshot, owner: ConversationMarkdownOwner): string | null {
  if (!snapshot.owner || snapshot.owner.hostId !== owner.hostId || snapshot.owner.sessionId !== owner.sessionId)
    return "This conversation's transcript is not available from its owning host yet.";
  if (snapshot.error) return `This conversation's transcript could not be loaded: ${snapshot.error}`;
  if (!snapshot.loaded || snapshot.loading) return "Wait for this conversation's transcript to finish loading.";
  if (snapshot.source !== "host") return "Reconnect to load this conversation from its owning host before copying it.";
  if (!snapshot.messages.length) return "This conversation has no messages to copy.";
  return null;
}

/** Construct the complete immutable payload before invoking any asynchronous clipboard API.
 * Only the display projection is consumed; this never reads native history or attachment bytes.
 */
export function captureConversationMarkdown(snapshot: ConversationMarkdownSnapshot, owner: ConversationMarkdownOwner, title: string): string {
  const issue = conversationMarkdownIssue(snapshot, owner);
  if (issue) throw new Error(issue);
  const sections = snapshot.messages.map(messageMarkdown).filter(section => section.trim().length > 0);
  if (!sections.length) throw new Error("This conversation has no displayable messages to copy.");
  return `# ${label(title.replace(/\s+/g, " ").trim() || "Conversation")}\n\n${sections.join("\n\n")}\n`;
}

function label(value: string): string { return value.replace(/[\\`*_{}\[\]<>#!|]/g, "\\$&"); }
function inline(value: string): string {
  const ticks = "`".repeat(longestTicks(value) + 1);
  return `${ticks} ${value.replace(/[\r\n]+/g, " ")} ${ticks}`;
}
function longestTicks(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}
function fenced(value: string, language = "text"): string {
  const fence = "`".repeat(Math.max(3, longestTicks(value) + 1));
  return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}
function quoted(value: string): string { return value.replace(/\r\n?/g, "\n").split("\n").map(line => line ? `> ${line}` : ">").join("\n"); }
function blockMarkdown(block: TranscriptBlock, output: boolean): string {
  switch (block.type) {
    case "text": return output ? fenced(block.text) : block.text;
    case "thinking": return "[Reasoning content is omitted from this Markdown export.]";
    case "toolCall": return `Tool call: ${inline(block.name)}${block.intent ? ` — ${label(block.intent)}` : ""}\n\n${fenced(JSON.stringify(block.arguments, null, 2), "json")}`;
    case "image": return `[Recorded image (${label(block.mimeType)}${block.bytes === undefined ? "" : `, ${block.bytes} bytes`}); image data is not included.]`;
    case "unsupported": return block.nativeType === "redactedThinking"
      ? "[The provider withheld this reasoning content.]"
      : `[Native ${label(block.nativeType)} content${block.mimeType ? ` (${label(block.mimeType)})` : ""} cannot be represented by this export.]`;
  }
}
function selectedContext(message: TranscriptMessage): string[] {
  return (message.selectedText?.attachments ?? []).map(attachment => {
    const { start, end } = attachment.source.range;
    return `Selected text: ${inline(attachment.source.path)} (${start.line}:${start.column}–${end.line}:${end.column})\n\n${fenced(attachment.text)}`;
  });
}
function outputQualifications(message: TranscriptMessage): string[] {
  const output = message.tool?.output, notes: string[] = [];
  if (!output) return notes;
  const truncation = output.truncation;
  if (truncation?.truncated) {
    const direction = truncation.direction === "head" ? "beginning shown" : truncation.direction === "tail" ? "end shown" : truncation.direction === "middle" ? "middle omitted" : undefined;
    notes.push(`Recorded output is truncated${direction ? ` (${direction})` : ""}; omitted content is not included.${truncation.partialLine ? " The shown line is partial." : ""}`);
    if (truncation.outputLines !== undefined && truncation.totalLines !== undefined) notes.push(`${truncation.outputLines} of ${truncation.totalLines} lines recorded.`);
    if (truncation.artifactId) notes.push(`Recorded full-output reference: ${inline(`artifact://${truncation.artifactId}`)} (not retrieved).`);
  }
  if (output.columnTruncated !== undefined) notes.push(`Recorded output columns are limited to ${output.columnTruncated}.`);
  if (output.summary && output.summary.elidedLines > 0) notes.push(`The recorded summary omits ${output.summary.elidedLines} lines.`);
  return notes;
}
function messageMarkdown(message: TranscriptMessage): string {
  if (message.role === "commandOutput" && message.commandOutput)
    return `Command output: ${inline(`/${message.commandOutput.command.replace(/^\//, "")}`)}\n\n${fenced(message.commandOutput.output)}`;
  if (message.role === "fileMention" && message.fileReferences) return message.fileReferences.map(file => {
    const contents = file.image
      ? `[Recorded image (${label(file.image.mimeType)}); image data is not included.${file.image.error ? ` ${label(file.image.error)}` : ""}]`
      : file.skippedReason ? `[File content was not recorded: ${file.skippedReason === "binary" ? "binary file" : "file too large"}.]` : fenced(file.content);
    return `File context: ${inline(file.path)}\n\n${contents}`;
  }).join("\n\n");
  if (message.role === "selectedText") return ["Saved selected context · prompt not linked", ...selectedContext(message)].join("\n\n");
  const output = message.role === "toolResult" || message.role === "tool";
  if (message.role !== "user" && message.role !== "assistant" && !output)
    return `[Native ${label(message.role)} message is not supported by this export; its payload is not included.]`;
  const sections = selectedContext(message);
  if (message.lifecycle === "streaming") sections.push("[Response in progress; this is only the recorded snapshot so far.]");
  if (output) {
    sections.push(`Tool result: ${inline(message.tool?.name ?? "Tool")} — ${toolOutcome(message).label}`);
    sections.push(...outputQualifications(message));
  }
  const blocks = messageBlocks(message);
  for (const block of blocks) sections.push(blockMarkdown(block, output));
  if (output && !blocks.length) sections.push(message.tool?.isError ? "The tool failed without output." : message.tool?.status === "completed" ? "No output was returned." : "No output has been received.");
  if (message.mcpArtifact) sections.push("[Interactive tool result is not embedded in this Markdown export.]");
  if (message.mcpArtifactError) sections.push(quoted(message.mcpArtifactError));
  const metadata = message.assistant;
  if (message.lifecycle === "complete") {
    if (metadata?.stopReason === "error") sections.push(quoted(metadata.errorMessage || "The provider ended this response with an error."));
    if (metadata?.stopReason === "aborted") sections.push(quoted(metadata.errorMessage || "This response was interrupted."));
    if (metadata?.stopReason === "length") sections.push("[The response reached its output limit.]");
  }
  const text = sections.filter(section => section.length > 0).join("\n\n");
  return message.role === "user" && text ? quoted(text) : text;
}
