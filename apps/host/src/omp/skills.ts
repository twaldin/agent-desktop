import { stat } from "node:fs/promises";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { getSkillSlashCommandName, parseSkillInvocation } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSkillCommandPrompt, type BuiltSkillCommandPrompt } from "@oh-my-pi/pi-coding-agent/modes/skill-command";
interface NativeSkillMessage { role: string; customType: string; content: unknown; details: unknown; display: boolean; attribution: string; timestamp: number }

/** Observe the actual native user-attributed custom message, never a fabricated
 * user row. Native persistence normalizes that message into a custom entry. */
export class NativeSkillPrompt {
  readonly name: string;
  #built?: BuiltSkillCommandPrompt;
  #message?: NativeSkillMessage;
  #restore?: () => void;
  get dispatched(): boolean { return this.#message !== undefined; }

  static fromText(session: AgentSession, text: string): NativeSkillPrompt | undefined {
    const invocation = parseSkillInvocation(text);
    if (!invocation) return undefined;
    if (!session.skillsSettings?.enableSkillCommands) throw new Error("Native skill commands are disabled for this session. The draft was retained.");
    if (!session.skills.some(skill => skill.name === invocation.name)) throw new Error(`Native skill ${invocation.name} is not loaded in this session. Refresh its command catalog.`);
    return new NativeSkillPrompt(session, text, invocation.name);
  }
  private constructor(private session: AgentSession, private text: string, name: string) { this.name = name; }

  async prepare(): Promise<void> {
    const skill = this.session.skills.find(item => item.name === this.name)!;
    const file = await stat(skill.filePath);
    if (!file.isFile() || file.size > 1024 * 1024) throw new Error("The native skill source exceeds the desktop's 1 MiB preparation limit or is not a file.");
    this.#built = await buildSkillCommandPrompt({ session: this.session, skillCommands: new Map(this.session.skills.map(item => [getSkillSlashCommandName(item), item])), showError: message => { throw new Error(message); } }, this.text, "followUp");
    if (!this.#built || typeof this.#built.message.content !== "string" || this.#built.message.content.length > 500_000) throw new Error("The expanded skill exceeds native durable text history limits. The draft was retained.");
    const agent = this.session.agent, original = agent.prompt;
    const wrapper = (async (...args: Parameters<typeof original>) => {
      if (!this.#message) {
        const messages = Array.isArray(args[0]) ? args[0] : [args[0]];
        const candidates = messages.filter(message => message.role === "custom" && message.customType === this.#built!.message.customType && message.attribution === "user");
        if (candidates.length !== 1) throw new Error("Native skill dispatch did not produce one attributable user skill message.");
        const message = candidates[0] as unknown as NativeSkillMessage;
        if (message.content !== this.#built!.message.content || JSON.stringify(message.details) !== JSON.stringify(this.#built!.message.details) || message.display !== true) throw new Error("Native preprocessing changed the selected skill content or identity.");
        this.#message = message;
      }
      return original.apply(agent, args);
    }) as typeof original;
    agent.prompt = wrapper;
    this.#restore = () => { if (agent.prompt === wrapper) agent.prompt = original; };
  }
  matchesEntry(entry: Parameters<NonNullable<SessionManager["onEntryAppended"]>>[0]): boolean {
    const message = this.#message;
    return Boolean(message && entry.type === "custom_message" && entry.customType === message.customType && entry.content === message.content
      && entry.display === true && entry.attribution === "user" && entry.timestamp === new Date(message.timestamp).toISOString()
      && JSON.stringify(entry.details) === JSON.stringify(message.details));
  }
  async dispatch(): Promise<boolean> {
    if (!this.#built) throw new Error("Native skill preparation was not completed.");
    return this.session.promptCustomMessage(this.#built.message, this.#built.options);
  }
  close(): void { this.#restore?.(); this.#restore = undefined; }
}
