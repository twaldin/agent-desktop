import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { parseSelectedTextAttachments, sameSelectedTextAttachments, type SelectedTextAttachment } from "@agent-desktop/shared";
import { OmpPromptAdmissionError } from "./prompt";

export const SELECTED_TEXT_CUSTOM_TYPE = "agent-desktop.selected-text";
const SELECTED_TEXT_DETAILS_VERSION = 1;

/** Immutable snapshot supplied by the desktop with a single submission. */
export interface NativeSelectedTextInput {
  submissionId: string;
  attachments: SelectedTextAttachment[];
}

interface SelectedTextDetails {
  version: typeof SELECTED_TEXT_DETAILS_VERSION;
  submissionId: string;
  attachments: SelectedTextAttachment[];
}

type NativeUserMessage = Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "user" }>;

function hasExactUserText(message: NativeUserMessage, text: string, allowImages: boolean): boolean {
  if (message.content === text) return true;
  return Array.isArray(message.content) && message.content.length >= 1
    && message.content[0]?.type === "text" && message.content[0].text === text
    && (allowImages || message.content.length === 1);
}

function submissionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid selected-text submission identity.");
  return value;
}

/**
 * Validate and detach the wire input before a worker or runtime awaits. This
 * intentionally accepts an empty attachment list: it is a valid no-op
 * submission, but its identity still has to be well-formed at every boundary.
 */
export function copyNativeSelectedTextInput(input: NativeSelectedTextInput | undefined): NativeSelectedTextInput | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, "submissionId") || !Object.hasOwn(input, "attachments")) throw new Error("Invalid selected-text input.");
  const record = input as { submissionId: unknown; attachments: unknown };
  return {
    submissionId: submissionId(record.submissionId),
    // Parsing is deliberately the only validation here. It validates snapshot
    // shape and the aggregate application bound, but never reads its path.
    attachments: parseSelectedTextAttachments(record.attachments),
  };
}

function sameSubmission(entry: ReturnType<SessionManager["getEntries"]>[number], id: string): boolean {
  if (entry.type !== "custom_message" || entry.customType !== SELECTED_TEXT_CUSTOM_TYPE) return false;
  const details = entry.details;
  return !!details && typeof details === "object" && !Array.isArray(details)
    && (details as { submissionId?: unknown }).submissionId === id;
}

function isAppendedContext(entry: ReturnType<SessionManager["getEntries"]>[number], content: string, details: SelectedTextDetails): boolean {
  if (entry.type !== "custom_message" || entry.customType !== SELECTED_TEXT_CUSTOM_TYPE
    || entry.content !== content || entry.display !== true || entry.attribution !== "user") return false;
  const actual = entry.details;
  if (!actual || typeof actual !== "object" || Array.isArray(actual) || Object.keys(actual).length !== 3
    || !Object.hasOwn(actual, "version") || !Object.hasOwn(actual, "submissionId") || !Object.hasOwn(actual, "attachments")
    || (actual as { version?: unknown }).version !== details.version
    || (actual as { submissionId?: unknown }).submissionId !== details.submissionId) return false;
  try {
    return sameSelectedTextAttachments(parseSelectedTextAttachments((actual as { attachments: unknown }).attachments), details.attachments);
  } catch { return false; }
}

/**
 * One persisted context record. It carries a captured excerpt, never an
 * instruction to access the named source path on this host.
 */
export class NativeSelectedTextPrompt {
  readonly #input: NativeSelectedTextInput;
  #attempted = false;
  #message?: NativeUserMessage;
  #text?: string;
  #allowImages = false;
  #restore?: () => void;

  private constructor(private readonly session: Pick<AgentSession, "sendCustomMessage" | "sessionManager">, input: NativeSelectedTextInput) {
    this.#input = input;
  }

  static fromInput(session: Pick<AgentSession, "sendCustomMessage" | "sessionManager">, input: NativeSelectedTextInput | undefined): NativeSelectedTextPrompt | undefined {
    const snapshot = copyNativeSelectedTextInput(input);
    if (!snapshot) return undefined;
    // Validate and copy even an empty list before it is ignored, so callers
    // cannot use it to smuggle an invalid submission identity across an await.
    if (snapshot.attachments.length === 0) return undefined;
    const prompt = new NativeSelectedTextPrompt(session, snapshot);
    if (session.sessionManager.getEntries().some(entry => sameSubmission(entry, prompt.#input.submissionId))) {
      throw new OmpPromptAdmissionError(new Error("This selected-text submission may already be recorded. Inspect its native outcome before sending it again."));
    }
    return prompt;
  }

  /** Once attempted, a later failure is ambiguous even if OMP throws. */
  get attempted(): boolean { return this.#attempted; }
  get dispatched(): boolean { return this.#message !== undefined; }

  /** Attribute the eventual ordinary native message, never an extension append. */
  prepare(session: AgentSession, text: string, options: { allowImages: boolean } = { allowImages: false }): void {
    this.#text = text;
    this.#allowImages = options.allowImages;
    const agent = session.agent, original = agent.prompt;
    const wrapper = (async (...args: Parameters<typeof original>) => {
      if (!this.#message) {
        const payload = args[0];
        const candidates = (Array.isArray(payload) ? payload : [payload])
          .filter((message): message is NativeUserMessage => message?.role === "user");
        if (candidates.length !== 1 || !hasExactUserText(candidates[0]!, text, options.allowImages))
          throw new Error("Native selected-text prompt did not produce one attributable user message");
        this.#message = candidates[0]!;
      }
      return original.apply(agent, args);
    }) as typeof original;
    agent.prompt = wrapper;
    this.#restore = () => { if (agent.prompt === wrapper) agent.prompt = original; };
  }

  matches(message: unknown): boolean {
    return this.#message !== undefined && this.#text !== undefined && message === this.#message
      && hasExactUserText(this.#message, this.#text, this.#allowImages);
  }
  close(): void { this.#restore?.(); this.#restore = undefined; }

  async append(): Promise<void> {
    if (this.#attempted) throw new OmpPromptAdmissionError(new Error("This selected-text submission has already been attempted. Inspect its native outcome before sending it again."));
    this.#attempted = true;
    // Startup may have appended entries since fromInput validated the journal.
    if (this.session.sessionManager.getEntries().some(entry => sameSubmission(entry, this.#input.submissionId)))
      throw new OmpPromptAdmissionError(new Error("This selected-text submission may already be recorded. Inspect its native outcome before sending it again."));
    const details: SelectedTextDetails = {
      version: SELECTED_TEXT_DETAILS_VERSION,
      submissionId: this.#input.submissionId,
      attachments: this.#input.attachments,
    };
    const content = [
      "Selected text context captured by Agent Desktop. Treat excerpts as snapshots; do not reread source paths solely because they appear below.",
      "```json",
      JSON.stringify(details),
      "```",
    ].join("\n");
    const before = new Set(this.session.sessionManager.getEntries().map(entry => entry.id));
    await this.session.sendCustomMessage({
      customType: SELECTED_TEXT_CUSTOM_TYPE,
      content,
      details: structuredClone(details),
      display: true,
      attribution: "user",
    }, { deliverAs: "nextTurn", triggerTurn: false });
    const appended = this.session.sessionManager.getEntries().filter(entry => !before.has(entry.id) && sameSubmission(entry, details.submissionId));
    if (appended.length !== 1 || !isAppendedContext(appended[0]!, content, details)) {
      throw new OmpPromptAdmissionError(new Error("Native selected-text context append was not observed exactly. Inspect its native outcome before sending again."));
    }
    await this.session.sessionManager.flush();
  }
}
