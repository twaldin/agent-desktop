import { useEffect, useMemo, useState } from "react";
import { detachedAnswerDraft, parseDetachedQuestionAnswers, type DetachedQuestion, type DetachedQuestionAnswer, type DetachedQuestionSnapshot } from "../../../../packages/shared/src/detached-questions";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { DraftController } from "./drafts";
import type { SubmissionController } from "./submissions";
import { Icon } from "./Icons";
import { useDetachedQuestions } from "./use-detached-questions";
import "./detached-questions.css";

export const detachedQuestionDraftId = (sessionId: string, questionId: string) => `question:${sessionId}:${questionId}`;

export function emptyDetachedAnswers(questions: readonly DetachedQuestion[]): DetachedQuestionAnswer[] {
  return questions.map(question => ({ questionId: question.id, selectedOptions: [] }));
}

export function readDetachedAnswers(text: string, questions: readonly DetachedQuestion[]): DetachedQuestionAnswer[] {
  return text === "" ? emptyDetachedAnswers(questions) : parseDetachedQuestionAnswers(JSON.parse(text), questions);
}

export function hasDetachedAnswer(answer: DetachedQuestionAnswer) {
  return answer.selectedOptions.length > 0 || Boolean(answer.customInput?.trim());
}

export function PendingDetachedQuestions({ bridge, hostId, sessionId, localHostId, connected, archived, drafts, submissions }:
  { bridge: DesktopBridge; hostId: string; sessionId: string; localHostId?: string; connected: boolean; archived: boolean; drafts: DraftController; submissions: SubmissionController }) {
  const { data, refresh } = useDetachedQuestions(bridge, hostId, sessionId, connected, localHostId);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => setDismissed(new Set()), [hostId, sessionId]);
  const visible = data.value?.questions.filter(question => question.status !== "closed" && question.delivery.status !== "delivered" && !dismissed.has(question.questionId)) ?? [];
  const snapshot = visible.find(question => question.status === "open") ?? visible[0];
  if (!snapshot) {
    if (!data.error && !data.cacheWarning) return null;
    return <div className="detached-question-refresh inline-error" role="alert"><span>{data.error ? `Questions could not be refreshed: ${data.error}` : data.cacheWarning}</span><button className="secondary-button" disabled={!connected} onClick={() => void refresh()}>Retry</button></div>;
  }
  return <DetachedQuestionCard key={snapshot.questionId} snapshot={snapshot} sessionId={sessionId} connected={connected && !data.error} archived={archived}
    drafts={drafts} submissions={submissions} refresh={refresh} dismiss={() => setDismissed(previous => new Set(previous).add(snapshot.questionId))}
    staleMessage={!connected ? "Offline question snapshot" : data.error ?? data.cacheWarning}/>;
}

export function DetachedQuestionCard({ snapshot, sessionId, connected, archived, drafts, submissions, refresh, dismiss, staleMessage }:
  { snapshot: DetachedQuestionSnapshot; sessionId: string; connected: boolean; archived: boolean; drafts: DraftController; submissions: SubmissionController; refresh(): void | Promise<void>; dismiss(): void; staleMessage?: string }) {
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const draftId = detachedQuestionDraftId(sessionId, snapshot.questionId);
  const view = drafts.get(draftId, { projectId: null, model: null });
  const pending = submissions.get(draftId);
  const parsed = useMemo(() => {
    try { return { answers: readDetachedAnswers(view.draft.text, snapshot.questions) }; }
    catch (cause) { return { answers: emptyDetachedAnswers(snapshot.questions), error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [view.draft.text, snapshot.questions]);
  const question = snapshot.questions[Math.min(index, snapshot.questions.length - 1)]!;
  const answer = parsed.answers.find(value => value.questionId === question.id)!;
  const editDisabled = archived || sending || view.status === "conflict" || snapshot.status !== "open";
  const submitDisabled = editDisabled || !connected;
  const titleId = `detached-question-${snapshot.questionId}`;

  function save(next: DetachedQuestionAnswer[]) {
    const validated = parseDetachedQuestionAnswers(next, snapshot.questions);
    drafts.update(draftId, { text: detachedAnswerDraft(validated) });
    setError(undefined);
  }
  function choose(label: string) {
    const selectedOptions = question.multi
      ? answer.selectedOptions.includes(label) ? answer.selectedOptions.filter(value => value !== label) : [...answer.selectedOptions, label]
      : [label];
    save(parsed.answers.map(value => value.questionId === question.id ? { ...value, selectedOptions, ...(!question.multi ? { customInput: undefined } : {}) } : value));
  }
  function customInput(value: string) {
    save(parsed.answers.map(item => item.questionId === question.id ? { ...item, customInput: value || undefined, ...(!question.multi ? { selectedOptions: [] } : {}) } : item));
  }
  async function submit() {
    if (submitDisabled || parsed.error) return;
    setSending(true); setError(undefined);
    let captured = pending?.uncertain ? pending.draft : undefined;
    try {
      captured ??= await drafts.prepareSubmission(draftId);
      const answers = readDetachedAnswers(captured.text, snapshot.questions);
      drafts.beginPendingSubmission(captured);
      const result = await submissions.submitQuestion(captured, sessionId, snapshot.questionId, snapshot.questionEntryId, answers,
        (submitted, commandId) => drafts.beginPendingSubmission(submitted, commandId));
      drafts.finishSubmission(draftId, result.submitted, true, false, result.commandId);
      await refresh();
    } catch (cause) {
      if (captured) drafts.finishSubmission(draftId, captured, false, submissions.get(draftId)?.uncertain, submissions.get(draftId)?.send?.id);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSending(false); }
  }

  if (snapshot.status === "accepted") return <section className="detached-question-card detached-question-status" aria-labelledby={titleId}>
    <QuestionHeader id={titleId} index={0} count={snapshot.questions.length} dismiss={dismiss}/>
    <p className="detached-question-prompt">{snapshot.questions[0]?.question ?? "Question answered"}</p>
    <p className="detached-delivery-state" role="status">{deliveryMessage(snapshot)}</p>
  </section>;

  return <section className="detached-question-card" aria-labelledby={titleId}>
    <QuestionHeader id={titleId} index={index} count={snapshot.questions.length} dismiss={dismiss}
      previous={() => setIndex(value => Math.max(0, value - 1))} next={() => setIndex(value => Math.min(snapshot.questions.length - 1, value + 1))}/>
    <div className="detached-question-body">
      {question.header && <p className="detached-question-label">{question.header}</p>}
      <p className="detached-question-prompt">{question.question}</p>
      {question.options.length > 0 ? <div className="detached-question-options" role={question.multi ? "group" : "radiogroup"} aria-label={question.question}>
        {question.options.map((option, optionIndex) => {
          const checked = answer.selectedOptions.includes(option.label);
          return <label className={`detached-question-option ${checked ? "selected" : ""}`} key={option.label}>
            <input type={question.multi ? "checkbox" : "radio"} name={`detached-${snapshot.questionId}-${question.id}`} value={option.label} checked={checked} disabled={editDisabled} onChange={() => choose(option.label)}/>
            <span className="detached-question-marker" aria-hidden="true">{checked ? <Icon name="check"/> : optionIndex + 1}</span>
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}{option.preview && <small>{option.preview}</small>}</span>
          </label>;
        })}
      </div> : <textarea rows={1} className="detached-question-reply" aria-label={`Reply to ${question.question}`} value={answer.customInput ?? ""} disabled={editDisabled} placeholder="Reply…" onChange={event => customInput(event.target.value)} autoFocus/>}
    </div>
    {(staleMessage || archived) && <p className="subtle-notice">{archived ? "Unarchive this conversation before answering." : staleMessage}</p>}
    {view.status === "conflict" && <div className="detached-question-conflict" role="alert"><strong>This answer draft changed on another device.</strong><p>Both versions are preserved. Choose which saved answer to continue editing.</p><div><button className="secondary-button" onClick={() => drafts.resolve(draftId, "remote")}>Use saved answer</button><button className="primary-button" onClick={() => drafts.resolve(draftId, "local")}>Keep my answer</button></div></div>}
    {(error || parsed.error) && <p className="inline-error" role="alert">{error ?? `This saved answer cannot be read: ${parsed.error}`}</p>}
    {pending?.uncertain && <p className="detached-question-uncertain" role="status">The answer outcome is unknown. Retry checks the original saved answer and command identity; it does not send a new copy.</p>}
    <div className="detached-question-actions">
      {question.options.length > 0 ? <label className="detached-question-custom"><span className="detached-question-pencil" aria-hidden="true"><Icon name="pencil"/></span><textarea rows={1} aria-label={`Own response for ${question.question}`} value={answer.customInput ?? ""} disabled={editDisabled} placeholder="Or write your own response" onChange={event => customInput(event.target.value)}/></label> : <span/>}
      <div>
      <button type="button" className="secondary-button" disabled={editDisabled || Boolean(parsed.error)} onClick={() => { save(parsed.answers.map(item => item.questionId === question.id ? { questionId: item.questionId, selectedOptions: [] } : item)); if (index < snapshot.questions.length - 1) setIndex(index + 1); else if (connected) void submit(); }}>Skip</button>
      {index < snapshot.questions.length - 1
        ? <button type="button" className="primary-button" disabled={editDisabled || !hasDetachedAnswer(answer) || Boolean(parsed.error)} onClick={() => setIndex(index + 1)}>Next</button>
        : <button type="button" className="primary-button" disabled={submitDisabled || Boolean(parsed.error) || (!pending?.uncertain && !hasDetachedAnswer(answer))} onClick={() => void submit()}>{pending?.uncertain ? "Retry" : sending ? "Sending…" : "Send"}</button>}
    </div></div>
    {(view.status === "saving" || view.status === "offline") && <p className="detached-question-draft-state" role="status">{view.status === "saving" ? "Saving…" : "Saved on this device"}</p>}
  </section>;
}

function QuestionHeader({ id, index, count, dismiss, previous, next }: { id: string; index: number; count: number; dismiss(): void; previous?(): void; next?(): void }) {
  return <header className="detached-question-heading"><div className="detached-question-title"><Icon name="question"/><strong id={id}>Question</strong></div><div className="detached-question-navigation">
    <button type="button" className="icon-button small detached-question-previous" aria-label="Previous question" disabled={!previous || index === 0} onClick={previous}><Icon name="chevron"/></button>
    <span>{index + 1} of {count}</span>
    <button type="button" className="icon-button small" aria-label="Next question" disabled={!next || index === count - 1} onClick={next}><Icon name="chevron"/></button>
    <button type="button" className="icon-button small" aria-label="Dismiss" onClick={dismiss}><Icon name="close"/></button>
  </div></header>;
}

function deliveryMessage(snapshot: DetachedQuestionSnapshot) {
  switch (snapshot.delivery.status) {
    case "waiting": return "Answer accepted. Waiting for delivery to the owning conversation.";
    case "delivering": return "Delivering your accepted answer to the conversation…";
    case "unknown": return `The answer was accepted, but its delivery outcome is unknown. ${snapshot.delivery.message}`;
    case "rejected": return `The answer was accepted, but could not be delivered. ${snapshot.delivery.message}`;
    case "delivered": return "Answer delivered.";
  }
}
