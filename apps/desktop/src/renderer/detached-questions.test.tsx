import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DetachedQuestionsSnapshot } from "../../../../packages/shared/src/detached-questions";
import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import { DraftController } from "./drafts";
import { SubmissionController } from "./submissions";
import { DetachedQuestionCard, emptyDetachedAnswers, hasDetachedAnswer, readDetachedAnswers } from "./DetachedQuestionCard";
import { DetachedQuestionsState } from "./use-detached-questions";

const snapshot: DetachedQuestionsSnapshot = { protocolVersion: 1, hostId: "host-a", sessionId: "session-a", questions: [{
  questionId: "question-a", questionEntryId: "entry-opened", originRunId: "run-a", openedAt: 10, status: "open", delivery: { status: "waiting" },
  questions: [
    { id: "density", header: "Density", question: "How dense should the layout be?", multi: false, recommended: 1, options: [{ label: "Comfortable", description: "More breathing room" }, { label: "Compact", description: "More content" }] },
    { id: "accent", question: "Which accent should the interface use?", multi: false, options: [] },
  ],
}] };

function stores() {
  const cache = { read: () => null, write: () => {} };
  return {
    drafts: new DraftController(async envelope => ({ ok: true, commandId: envelope.id, value: { id: envelope.command.type === "draft.put" ? envelope.command.draft.id : "draft", revision: 1, updatedAt: 1, text: envelope.command.type === "draft.put" ? envelope.command.draft.text : "", projectId: null, model: null } }), "host-a", cache),
    submissions: new SubmissionController(async envelope => ({ ok: true, commandId: envelope.id }), "host-a", cache),
  };
}

describe("detached question card", () => {
  test("renders native question navigation, options, own response, and explicit send controls", () => {
    const { drafts, submissions } = stores();
    const html = renderToStaticMarkup(<DetachedQuestionCard snapshot={snapshot.questions[0]!} sessionId="session-a" connected archived={false} drafts={drafts} submissions={submissions} refresh={() => {}} dismiss={() => {}}/>);
    expect(html).toContain("aria-label=\"Previous question\"");
    expect(html).toContain("aria-label=\"Next question\"");
    expect(html).toContain("aria-label=\"Dismiss\"");
    expect(html).toContain("1 of 2");
    expect(html).toContain("How dense should the layout be?");
    expect(html).toContain("type=\"radio\"");
    expect(html).toContain("Comfortable");
    expect(html).toContain("Or write your own response");
    expect(html).toContain(">Skip<");
    expect(html).toContain(">Next<");
  });

  test("renders accepted delivery state without answer controls", () => {
    const { drafts, submissions } = stores();
    const accepted = { ...snapshot.questions[0]!, status: "accepted" as const,
      acceptance: { commandId: "command-a", acceptanceEntryId: "accepted-a", acceptedAt: 20, answers: emptyDetachedAnswers(snapshot.questions[0]!.questions) },
      delivery: { status: "delivering" as const, attemptEntryId: "attempt-a" } };
    const html = renderToStaticMarkup(<DetachedQuestionCard snapshot={accepted} sessionId="session-a" connected archived={false} drafts={drafts} submissions={submissions} refresh={() => {}} dismiss={() => {}}/>);
    expect(html).toContain("Delivering your accepted answer");
    expect(html).not.toContain("type=\"radio\"");
    expect(html).not.toContain(">Send<");
  });

  test("keeps a cached open question editable offline while disabling delivery", () => {
    const { drafts, submissions } = stores();
    const html = renderToStaticMarkup(<DetachedQuestionCard snapshot={snapshot.questions[0]!} sessionId="session-a" connected={false} archived={false} drafts={drafts} submissions={submissions} refresh={() => {}} dismiss={() => {}} staleMessage="Offline question snapshot"/>);
    const compact = html.match(/<input[^>]+value="Compact"[^>]*>/)?.[0];
    const ownResponse = html.match(/<textarea[^>]+Own response[^>]*>/)?.[0];
    const skip = html.match(/<button[^>]*>Skip<\/button>/)?.[0];
    expect(compact).not.toContain("disabled");
    expect(ownResponse).not.toContain("disabled");
    expect(skip).not.toContain("disabled");
    expect(html.match(/<button[^>]*disabled=""[^>]*>Next<\/button>/)).not.toBeNull();
    expect(html).toContain("Offline question snapshot");
    expect(html).not.toContain("✎");
  });

  test("canonical answer helpers retain unanswered questions and treat selection as local editing", () => {
    const answers = emptyDetachedAnswers(snapshot.questions[0]!.questions);
    expect(answers).toEqual([{ questionId: "density", selectedOptions: [] }, { questionId: "accent", selectedOptions: [] }]);
    expect(hasDetachedAnswer(answers[0]!)).toBe(false);
    const parsed = readDetachedAnswers(JSON.stringify([{ questionId: "density", selectedOptions: ["Compact"] }, { questionId: "accent", selectedOptions: [], customInput: "Cobalt" }]), snapshot.questions[0]!.questions);
    expect(hasDetachedAnswer(parsed[0]!)).toBe(true);
    expect(parsed[1]?.customInput).toBe("Cobalt");
  });
});

describe("detached question refresh state", () => {
  test("restores an owner-bound cache offline and refreshes on matching native events only", async () => {
    const values = new Map([["agent-desktop:detached-questions:v1:host-a:session-a", JSON.stringify(snapshot)]]);
    let listener: ((event: DesktopEvent) => void) | undefined, reads = 0;
    const state = new DetachedQuestionsState({
      getDetachedQuestions: async () => { reads++; return snapshot; },
      subscribe: callback => { listener = callback; return () => { listener = undefined; }; },
    }, "host-a", "session-a", "local", { read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); } });
    await state.restore();
    expect(state.value).toEqual(snapshot);
    state.start(); state.setConnected(true);
    await state.refresh();
    const baseline = reads;
    listener?.({ sequence: 1, type: "runtime", hostId: "host-b", sessionId: "session-a", event: {} });
    await Promise.resolve();
    expect(reads).toBe(baseline);
    listener?.({ sequence: 2, type: "interactions", hostId: "host-a", sessionId: "session-a" });
    await new Promise(resolve => setTimeout(resolve, 110));
    await state.refresh();
    expect(reads).toBeGreaterThan(baseline);
    state.stop();
  });
});
