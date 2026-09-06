import { createRoot } from "react-dom/client";
import { useEffect, useReducer, useState } from "react";
import type { DetachedQuestionsSnapshot } from "../../packages/shared/src/detached-questions";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent, Draft } from "../../packages/shared/src/protocol";
import { DraftController } from "../../apps/desktop/src/renderer/drafts";
import { PendingDetachedQuestions } from "../../apps/desktop/src/renderer/DetachedQuestionCard";
import { SubmissionController } from "../../apps/desktop/src/renderer/submissions";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const hostId = "host-a", sessionId = "session-a";
let questionState: DetachedQuestionsSnapshot = { protocolVersion: 1, hostId, sessionId, questions: [{ questionId: "question-a", questionEntryId: "opened-a", originRunId: "run-a", openedAt: 1, status: "open", delivery: { status: "waiting" }, questions: [
  { id: "density", header: "Density", question: "How dense should the layout be?", multi: false, recommended: 1, options: [{ label: "Comfortable", description: "More breathing room" }, { label: "Compact", description: "Fit more work on screen" }] },
  { id: "accent", question: "Which accent should the interface use?", multi: false, options: [] },
] }] };
const listeners = new Set<(event: DesktopEvent) => void>(), commands: CommandEnvelope[] = [];
const cache = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key, value) };
const command = async (envelope: CommandEnvelope): Promise<CommandResult> => {
  commands.push(structuredClone(envelope));
  if (envelope.command.type === "draft.put") {
    const draft: Draft = { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: Date.now() };
    return { ok: true, commandId: envelope.id, value: draft };
  }
  if (envelope.command.type !== "session.question.answer") throw new Error(`Unexpected command ${envelope.command.type}`);
  questionState = { ...questionState, questions: questionState.questions.map(question => question.questionId === envelope.command.questionId ? { ...question, status: "accepted", acceptance: { commandId: envelope.id, acceptanceEntryId: "accepted-a", acceptedAt: Date.now(), answers: envelope.command.answers }, delivery: { status: "waiting" } } : question) };
  return { ok: true, commandId: envelope.id, value: { type: "session.question.answer", receipt: { questionId: envelope.command.questionId, acceptanceEntryId: "accepted-a", delivery: "waiting" } } };
};
const bridge = { getDetachedQuestions: async () => structuredClone(questionState), subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as DesktopBridge;
const drafts = new DraftController(command, hostId, cache), submissions = new SubmissionController(command, hostId, cache);
let setHarnessConnected: (value: boolean) => void = () => {};
function Harness() {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [connected, setConnected] = useState(true); setHarnessConnected = setConnected;
  useEffect(() => { const offDrafts = drafts.subscribe(redraw), offSubmissions = submissions.subscribe(redraw); return () => { offDrafts(); offSubmissions(); }; }, []);
  useEffect(() => drafts.setConnected(connected), [connected]);
  return <main style={{ width: "min(768px, calc(100vw - 32px))", margin: "40px auto" }}><PendingDetachedQuestions bridge={bridge} hostId={hostId} sessionId={sessionId} localHostId={hostId} connected={connected} archived={false} drafts={drafts} submissions={submissions}/></main>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

const wait = async (read: () => unknown, label: string) => { const start = performance.now(); while (performance.now() - start < 5000) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);
const input = (element: HTMLTextAreaElement, value: string) => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); };
const questionCommands = () => commands.filter(value => value.command.type === "session.question.answer");
Object.assign(window, { waitDetachedQuestionOpen: () => wait(() => document.querySelector(".detached-question-card"), "question card"), prepareDetachedQuestionOffline: async () => {
  setHarnessConnected(false); await wait(() => document.body.textContent?.includes("Offline question snapshot"), "offline question state");
  document.querySelector<HTMLInputElement>('input[value="Compact"]')!.click();
  if (questionCommands().length) throw new Error("Selecting an offline option submitted an answer");
  await wait(() => !button("Next")!.disabled, "offline Next enabled"); button("Next")!.click(); await wait(() => document.body.textContent?.includes("Which accent"), "offline second question");
  input(document.querySelector<HTMLTextAreaElement>('.detached-question-reply')!, "Cobalt");
  await wait(() => document.querySelector<HTMLTextAreaElement>('.detached-question-reply')!.value === "Cobalt", "offline text persisted");
  if (!button("Send")!.disabled || button("Skip")!.disabled) throw new Error("Offline edit and delivery controls are coupled");
  button("Skip")!.click(); await new Promise(resolve => setTimeout(resolve, 50));
  if (questionCommands().length) throw new Error("Last-question Skip submitted while offline");
  return { offlineEdited: true };
}, runDetachedQuestionAcceptance: async () => {
  input(document.querySelector<HTMLTextAreaElement>('.detached-question-reply')!, "Cobalt");
  setHarnessConnected(true); await wait(() => !document.body.textContent?.includes("Offline question snapshot") && !button("Send")!.disabled, "reconnected Send");
  if (questionCommands().length) throw new Error("Offline edits submitted before reconnect and Send"); button("Send")!.click();
  await wait(() => document.body.textContent?.includes("Answer accepted. Waiting"), "accepted waiting state");
  const sent = questionCommands()[0]?.command;
  if (!sent || sent.type !== "session.question.answer" || sent.questionId !== "question-a" || sent.questionEntryId !== "opened-a" || sent.draft.id !== `question:${sessionId}:question-a` || sent.answers[0]?.selectedOptions[0] !== "Compact" || sent.answers[1]?.customInput !== "Cobalt") throw new Error("Question command lost its exact draft or native identity");
  return { passed: true, questionCommands: questionCommands().length, draftWrites: commands.filter(value => value.command.type === "draft.put").length, command: sent };
} });
