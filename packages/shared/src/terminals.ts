import type { WorkspaceTarget } from "./workspace";

/** App terminal geometry bounds; requested sizes are clamped to these values. */
export const TERMINAL_DIMENSIONS = { minimumCols: 20, maximumCols: 400, minimumRows: 5, maximumRows: 200 } as const;
export interface TerminalInfo {
  id: string;
  target: WorkspaceTarget;
  /** Initial owning directory; an interactive `cd` does not change catalog ownership. */
  cwd: string;
  shell: string;
  pid: number | null;
  cols: number;
  rows: number;
  status: "starting" | "running" | "closing" | "exited" | "error";
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  cancelled?: boolean;
  error?: string;
}
export interface TerminalChunk { sequence: number; data: string }
export interface TerminalReplay {
  terminal: TerminalInfo;
  chunks: TerminalChunk[];
  firstSequence: number;
  lastSequence: number;
  /** Earlier output was evicted; the returned tail is not a complete TUI screen snapshot. */
  truncated: boolean;
}
export type TerminalEvent = { type: "output"; terminalId: string; chunk: TerminalChunk }
  | { type: "state"; terminal: TerminalInfo }
  | { type: "removed"; terminalId: string };
export interface TerminalCreateOptions { target: WorkspaceTarget; cols?: number; rows?: number }
export type TerminalAction =
  | { type: "create"; options: TerminalCreateOptions; viewerId?: string }
  | { type: "input"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "viewer"; terminalId: string; viewerId: string; afterSequence: number; leaseId?: string; release?: boolean }
  | { type: "close"; terminalId: string }
  | { type: "forget"; terminalId: string };

export type TerminalControlAction = Exclude<TerminalAction, { type: "input" }>;
export interface TerminalViewerLease { leaseId: string; viewerId: string; expiresAt: number; startSequence: number; completedSequence: number }
export interface TerminalActionResult { terminal?: TerminalInfo; viewer?: TerminalViewerLease }
/** Ephemeral per-client stream identity; payloads never enter the generic command journal. */
export interface TerminalReplyReference { leaseId: string; outputSequence: number; ordinal: number }
export interface TerminalInputRequest { terminalId: string; clientId: string; sequence: number; data: string; encoding?: "utf8" | "base64"; reply?: TerminalReplyReference }
export interface TerminalInputReceipt { sequence: number; duplicate: boolean; accepted?: boolean }
export type TerminalQuery = { type: "list"; target?: WorkspaceTarget } | { type: "replay"; terminalId: string; afterSequence?: number };
export type TerminalQueryResult = { type: "list"; terminals: TerminalInfo[] } | { type: "replay"; replay: TerminalReplay };
export type TerminalInvalidation = { type: "output"; terminalId: string; lastSequence: number }
  | { type: "state"; terminal: TerminalInfo } | { type: "removed"; terminalId: string };
export type DesktopTerminalEvent = TerminalInvalidation & { hostId: string };
export interface TerminalBridge {
  getTerminals(target?: WorkspaceTarget, hostId?: string): Promise<TerminalInfo[]>;
  getTerminalReplay(terminalId: string, afterSequence?: number, hostId?: string): Promise<TerminalReplay>;
  terminalAction(action: TerminalControlAction, hostId?: string): Promise<TerminalActionResult>;
  writeTerminal(input: TerminalInputRequest, hostId?: string): Promise<TerminalInputReceipt>;
  subscribeTerminals(listener: (event: DesktopTerminalEvent) => void): () => void;
}

/** v2 is a native private-tmux transport. Old PTY ring output is never a screen snapshot. */
export const NATIVE_TERMINAL_PROTOCOL = "tmux-v1" as const;
export interface NativeTerminalCapabilities {
  protocol: typeof NATIVE_TERMINAL_PROTOCOL;
  tmuxVersion: "3.7c";
  inputEpoch: string;
  dimensions: typeof TERMINAL_DIMENSIONS;
}
export interface NativeTerminalInfo extends Omit<TerminalInfo, "status"> {
  protocol: typeof NATIVE_TERMINAL_PROTOCOL;
  status: TerminalInfo["status"] | "interrupted";
  serverGeneration: string;
  geometryRevision: number;
  inputEpoch: string;
  /** Current native server/pane can supply a fresh real attachment, including retained final output. */
  attachable?: boolean;
}
/** One native attach PTY per viewer. Reset xterm before reading a new attachment. */
export interface NativeTerminalAttachment {
  id: string;
  terminalId: string;
  viewerId: string;
  inputEpoch: string;
  geometryRevision: number;
  cols: number;
  rows: number;
  expiresAt: number;
}
export interface NativeTerminalReplay {
  attachment: NativeTerminalAttachment;
  terminal: NativeTerminalInfo;
  chunks: TerminalChunk[];
  firstSequence: number;
  lastSequence: number;
  /** Discard this attachment and reset xterm. A fresh native attachment redraws the same pane. */
  resetRequired: boolean;
}
export interface NativeTerminalHistory {
  terminalId: string;
  serverGeneration: string;
  revision: string;
  capturedAt: number;
  cols: number;
  rows: number;
  /** True when captured from the still-live owning pane; false is an explicitly saved final cache. */
  live: boolean;
  history: string;
  /** Native current viewport captured for read-only history/final-output display. */
  screen?: string;
  savedNormalScreen?: string;
  truncated: boolean;
}
export type NativeTerminalInput =
  | { kind: "text"; data: string }
  | { kind: "bytes"; base64: string }
  | { kind: "key"; key: string }
  | { kind: "paste"; data: string }
  | { kind: "mouse"; button: number; col: number; row: number; release: boolean };
/** Mouse coordinates are 1-based cells of the complete accepted grid; button uses SGR bits. */
export interface NativeTerminalInputRequest {
  terminalId: string;
  attachmentId: string;
  inputEpoch: string;
  geometryRevision: number;
  clientId: string;
  sequence: number;
  input: NativeTerminalInput;
}
export interface NativeTerminalInputReceipt {
  sequence: number;
  duplicate: boolean;
  outcome: "accepted" | "not-submitted" | "uncertain";
  code?: string;
  message?: string;
}
export type NativeTerminalAction =
  | { type: "create"; options: TerminalCreateOptions }
  | { type: "attach"; terminalId: string; viewerId: string }
  | { type: "detach"; attachmentId: string }
  | { type: "heartbeat"; attachmentId: string; afterSequence: number; geometryRevision: number }
  | { type: "resize"; terminalId: string; attachmentId: string; geometryRevision: number; cols: number; rows: number }
  | { type: "reply"; attachmentId: string; outputSequence: number; ordinal: number; data: string }
  | { type: "focus"; attachmentId: string; focused: boolean }
  | { type: "close"; terminalId: string }
  | { type: "forget"; terminalId: string };
export interface NativeTerminalActionResult { terminal?: NativeTerminalInfo; attachment?: NativeTerminalAttachment; accepted?: boolean }
export type NativeTerminalQuery =
  | { type: "list"; target?: WorkspaceTarget }
  | { type: "replay"; attachmentId: string; afterSequence: number }
  | { type: "history"; terminalId: string };
export type NativeTerminalQueryResult =
  | { type: "list"; terminals: NativeTerminalInfo[] }
  | { type: "replay"; replay: NativeTerminalReplay }
  | { type: "history"; history: NativeTerminalHistory };
export type NativeTerminalInvalidation =
  | { type: "output"; terminalId: string; attachmentId: string; lastSequence: number }
  | { type: "state"; terminal: NativeTerminalInfo }
  | { type: "detached"; terminalId: string; attachmentId: string }
  | { type: "removed"; terminalId: string };
/** All v2 calls explicitly negotiate capability. Never fall back to v1 replay for native attachments. */
export interface NativeTerminalBridge {
  getNativeTerminalCapabilities(hostId?: string): Promise<NativeTerminalResult<NativeTerminalCapabilities>>;
  nativeTerminalQuery(query: NativeTerminalQuery, hostId?: string): Promise<NativeTerminalResult<NativeTerminalQueryResult>>;
  nativeTerminalAction(action: NativeTerminalAction, hostId?: string): Promise<NativeTerminalResult<NativeTerminalActionResult>>;
  writeNativeTerminal(input: NativeTerminalInputRequest, hostId?: string): Promise<NativeTerminalResult<NativeTerminalInputReceipt>>;
  subscribeNativeTerminals(listener: (event: NativeTerminalInvalidation & { hostId: string }) => void): () => void;
}
export type NativeTerminalResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; status?: number; code?: string } };
