import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { resolveFileDisplayMode } from "@oh-my-pi/pi-coding-agent/utils/file-display-mode";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import { hasRepeatedWholeFileIntent, hasRepeatedWholeFileSources, parseInlineWholeFileMentions, parseWholeFileAttachments, serializeRepeatedWholeFilePrompt, serializeWholeFilePrompt, type WholeFileAttachment } from "@agent-desktop/shared";
import { OmpPromptAdmissionError } from "./prompt";

export const WHOLE_FILE_BINDING_TYPE = "agent-desktop.whole-file-binding";
export const WHOLE_FILE_ATTEMPT_TYPE = "agent-desktop.whole-file-attempt";
export interface NativeWholeFileInput { submissionId: string; attachments: WholeFileAttachment[] }

function label(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid whole-file ${name}.`);
  return value;
}

/** Detach only identity/path intent. The owning server authorizes source-host identity; this accepts any canonical absolute path on that host. */
export function copyNativeWholeFileInput(input: NativeWholeFileInput | undefined, textLength?: number): NativeWholeFileInput | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "submissionId") || !Object.hasOwn(input, "attachments") || !Array.isArray(input.attachments)) throw new Error("Invalid whole-file input.");
  const repeated = hasRepeatedWholeFileIntent({ wholeFileAttachments: input.attachments });
  if (repeated && textLength === undefined) throw new Error("Repeated whole-file mentions require authored text length.");
  const attachments = repeated
    ? parseInlineWholeFileMentions(input.attachments, textLength!)
    : parseWholeFileAttachments(input.attachments, textLength);
  // A v3 binding represents one owning host's native read. Keep mixed-owner
  // metadata from producing history that its strict projector cannot verify.
  if (repeated && new Set(attachments.map(item => item.source.hostId)).size !== 1)
    throw new Error("Repeated whole-file mentions must belong to one owning host.");
  return { submissionId: label(input.submissionId, "submission identity", 200), attachments };
}

function exactUserText(value: unknown, expected: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { role?: unknown }).role !== "user") return false;
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content === expected;
  if (!Array.isArray(content) || content[0]?.type !== "text" || content[0].text !== expected) return false;
  return content.slice(1).every(block => block && typeof block === "object" && !Array.isArray(block) && (block as { type?: unknown }).type !== "text");
}

function sameSubmission(entry: ReturnType<SessionManager["getEntries"]>[number], submissionId: string): boolean {
  return entry.type === "custom" && (entry.customType === WHOLE_FILE_ATTEMPT_TYPE || entry.customType === WHOLE_FILE_BINDING_TYPE)
    && !!entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
    && (entry.data as { submissionId?: unknown }).submissionId === submissionId;
}

/** OMP deliberately omits unreadable/missing paths. Whole-file intent is atomic:
 * retain the draft rather than silently dropping part of the user's context. */
function generatedPaths(messages: readonly unknown[]): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const files = (message as { files?: unknown }).files;
    if (!Array.isArray(files)) continue;
    for (const file of files) if (file && typeof file === "object" && !Array.isArray(file) && typeof (file as { path?: unknown }).path === "string") paths.add((file as { path: string }).path);
  }
  return paths;
}

/**
 * Native whole-file admission. It uses OMP's generator rather than an @path
 * string, then injects its actual fileMention message into this exact agent
 * prompt. The binding is metadata only; file bytes remain OMP-owned history.
 */
export class NativeWholeFilePrompt {
  readonly #input: NativeWholeFileInput;
  #attempted = false;
  #restore?: () => void;
  #files: unknown[] = [];
  #fileEntryIds: string[] = [];
  #user?: unknown;
  readonly #authoredText: string;
  readonly #nativeText: string;

  private constructor(private readonly session: Pick<AgentSession, "agent" | "sessionManager">, input: NativeWholeFileInput, authoredText: string) {
    this.#input = input; this.#authoredText = authoredText; this.#nativeText = hasRepeatedWholeFileSources(input.attachments)
      ? serializeRepeatedWholeFilePrompt(authoredText, input.attachments) : serializeWholeFilePrompt(authoredText, input.attachments);
  }
  static fromInput(session: Pick<AgentSession, "agent" | "sessionManager">, input: NativeWholeFileInput | undefined, authoredText = ""): NativeWholeFilePrompt | undefined {
    const copied = copyNativeWholeFileInput(input, authoredText.length); if (!copied || !copied.attachments.length) return;
    if (session.sessionManager.getEntries().some(entry => sameSubmission(entry, copied.submissionId))) throw new OmpPromptAdmissionError(new Error("This whole-file submission may already be recorded. Inspect its native outcome before sending it again."));
    return new NativeWholeFilePrompt(session, copied, authoredText);
  }
  get attempted(): boolean { return this.#attempted; }
  get dispatched(): boolean { return this.#files.length > 0; }
  matches(message: unknown): boolean { return this.#files.includes(message); }
  close(): void { this.#restore?.(); this.#restore = undefined; }

  async prepare(session: AgentSession): Promise<void> {
    if (this.#attempted) throw new OmpPromptAdmissionError(new Error("This whole-file submission has already been attempted. Inspect its native outcome before sending it again."));
    if (session.sessionManager.getEntries().some(entry => sameSubmission(entry, this.#input.submissionId))) throw new OmpPromptAdmissionError(new Error("This whole-file submission may already be recorded. Inspect its native outcome before sending it again."));
    const repeated = hasRepeatedWholeFileSources(this.#input.attachments);
    const requestedPaths = repeated ? [...new Set(this.#input.attachments.map(item => item.source.path))]
      : this.#input.attachments.map(item => item.source.path);
    const generated = await generateFileMentionMessages(requestedPaths, session.sessionManager.getCwd(), {
      autoResizeImages: session.settings.get("images.autoResize"),
      useHashLines: resolveFileDisplayMode(session).hashLines,
      snapshotStore: getEditStore(session),
    });
    if (!generated.length) throw new Error("None of the selected files could be read by the owning host.");
    const requested = requestedPaths, recorded = generatedPaths(generated);
    if (requested.some(file => !recorded.has(file))) throw new Error("One or more selected files could not be read by the owning host. The draft was preserved.");
    // Reading/generation is preflight: if no native message was built, the
    // command has a definite rejection and its preserved draft may be retried.
    this.#attempted = true;
    const attempt = { version: 1, submissionId: this.#input.submissionId };
    const attemptId = session.sessionManager.appendCustomEntry(WHOLE_FILE_ATTEMPT_TYPE, attempt);
    const attemptEntry = session.sessionManager.getEntries().find(entry => entry.id === attemptId);
    if (attemptEntry?.type !== "custom" || attemptEntry.customType !== WHOLE_FILE_ATTEMPT_TYPE || JSON.stringify(attemptEntry.data) !== JSON.stringify(attempt)) throw new OmpPromptAdmissionError(new Error("Native whole-file attempt marker was not recorded exactly."));
    await session.sessionManager.flush();
    this.#files = generated;
    const agent = session.agent, original = agent.prompt;
    const wrapper = (async (...args: Parameters<typeof original>) => {
      const payload = args[0], messages = Array.isArray(payload) ? payload : [payload];
      const users = messages.filter(message => message?.role === "user");
      if (users.length !== 1 || !exactUserText(users[0], this.#nativeText)) throw new Error("Native whole-file prompt did not produce one attributable user message.");
      this.#user = users[0];
      // Place actual native file messages before their user message so the durable
      // binding can be atomically observed before the ordinary admission receipt.
      return (original as (...callArgs: unknown[]) => unknown).call(agent, [...this.#files, ...messages], ...args.slice(1));
    }) as typeof original;
    agent.prompt = wrapper; this.#restore = () => { if (agent.prompt === wrapper) agent.prompt = original; };
  }

  observe(entry: ReturnType<SessionManager["getEntries"]>[number]): void {
    if (entry.type === "message" && this.matches(entry.message)) this.#fileEntryIds.push(entry.id);
  }
  async persistBinding(userEntryId: string): Promise<void> {
    const entries = this.session.sessionManager.getEntries();
    const user = entries.find(entry => entry.id === userEntryId);
    if (user?.type !== "message" || user.message !== this.#user || !exactUserText(user.message, this.#nativeText)
      || this.#fileEntryIds.length !== this.#files.length) throw new Error("Native whole-file context has no attributable persisted entries.");
    const repeated = hasRepeatedWholeFileSources(this.#input.attachments), inline = this.#input.attachments.some(item => item.textOffset !== undefined);
    const data = inline
      ? { version: repeated ? 3 : 2, submissionId: this.#input.submissionId, userEntryId, fileEntryIds: [...this.#fileEntryIds], authoredText: this.#authoredText, attachments: this.#input.attachments }
      : { version: 1, submissionId: this.#input.submissionId, userEntryId, fileEntryIds: [...this.#fileEntryIds] };
    const id = this.session.sessionManager.appendCustomEntry(WHOLE_FILE_BINDING_TYPE, data);
    const binding = this.session.sessionManager.getEntries().find(entry => entry.id === id);
    if (binding?.type !== "custom" || binding.customType !== WHOLE_FILE_BINDING_TYPE || JSON.stringify(binding.data) !== JSON.stringify(data)) throw new Error("Native whole-file binding was not recorded exactly.");
    await this.session.sessionManager.flush();
  }
}
