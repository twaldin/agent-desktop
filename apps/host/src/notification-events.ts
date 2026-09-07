import type { DetachedQuestionSnapshot, HostEvent, HostNotification, OmpInteraction, SessionSummary } from "@agent-desktop/shared";

type EventInput = Omit<Extract<HostEvent, { type: "notification" }>, "sequence">;

export class NotificationEvents {
  private readonly latest = new Map<string, HostNotification>();
  private readonly verifiedOpen = new Set<string>();

  constructor(private readonly options: {
    eventsAfter(sequence: number, limit: number): HostEvent[];
    emit(event: EventInput): void;
    session(sessionId: string): SessionSummary | undefined;
  }) {
    let sequence = 0;
    while (true) {
      const page = options.eventsAfter(sequence, 1000);
      for (const event of page) {
        sequence = event.sequence;
        if (event.type === "notification") this.latest.set(event.notification.id, event.notification);
      }
      if (page.length < 1000) break;
    }
  }

  /** Historical open interactions belonged to workers that died with the prior host. */
  settleStaleInteractions(): void {
    for (const notification of [...this.latest.values()]) {
      if (notification.state === "open" && notification.id.startsWith("interaction:")) {
        this.record({ ...notification, state: "resolved" });
      }
    }
  }

  current(): HostNotification[] {
    return [...this.latest.values()]
      .filter(item => item.kind !== "completion" && item.state === "open" && this.verifiedOpen.has(item.id))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(item => structuredClone(item));
  }

  recoverySessionIds(): string[] {
    return [...new Set([...this.latest.values()]
      .filter(item => item.state === "open" && item.id.startsWith("question:"))
      .map(item => item.sessionId))];
  }

  interactionRequested(interaction: OmpInteraction): void {
    const kind = interaction.notificationKind === "permission" ? "permission" : "question";
    const notification = this.base(`interaction:${interaction.sessionId}:${interaction.id}`, interaction.sessionId, kind, interaction.createdAt,
      kind === "permission" ? "Permission required" : "Your answer is needed");
    this.verifiedOpen.add(notification.id);
    this.record(notification);
  }

  interactionResolved(sessionId: string, interactionId: string): void {
    const id = `interaction:${sessionId}:${interactionId}`;
    const current = this.latest.get(id);
    this.verifiedOpen.delete(id);
    if (current?.state === "open") this.record({ ...current, state: "resolved" });
  }

  reconcileDetached(sessionId: string, questions: readonly DetachedQuestionSnapshot[]): void {
    const seen = new Set<string>();
    for (const question of questions) {
      const id = `question:${sessionId}:${question.questionEntryId}`;
      seen.add(id);
      const notification = this.base(id, sessionId, "question", question.openedAt, "Your answer is needed");
      if (question.status === "open") {
        this.verifiedOpen.add(id);
        this.record(notification);
      } else {
        this.verifiedOpen.delete(id);
        const current = this.latest.get(id);
        if (current?.state === "open") this.record({ ...current, state: "resolved" });
      }
    }
    for (const notification of [...this.latest.values()]) {
      if (notification.sessionId !== sessionId || !notification.id.startsWith(`question:${sessionId}:`) || notification.state !== "open" || seen.has(notification.id)) continue;
      this.verifiedOpen.delete(notification.id);
      this.record({ ...notification, state: "resolved" });
    }
  }

  completion(sessionId: string, id: string, outcome: "completed" | "failed" | "stopped", createdAt = Date.now()): void {
    const body = outcome === "completed" ? "Conversation completed" : outcome === "stopped" ? "Conversation stopped" : "Conversation failed";
    this.record(this.base(id, sessionId, "completion", createdAt, body));
  }

  private base(id: string, sessionId: string, kind: HostNotification["kind"], createdAt: number, body: string): HostNotification {
    return { id, sessionId, kind, state: "open", createdAt,
      title: (this.options.session(sessionId)?.title.trim() || "Conversation").slice(0, 120), body };
  }

  private record(notification: HostNotification): void {
    const current = this.latest.get(notification.id);
    if (current?.state === notification.state && current.kind === notification.kind) return;
    this.options.emit({ type: "notification", notification });
    this.latest.set(notification.id, notification);
  }
}
