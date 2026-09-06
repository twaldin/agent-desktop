const MAX_TEXT = 16_384;
const MAX_QUESTION = 4_096;
const MAX_SHORT = 200;
const MAX_OPTIONS = 20;

export interface DetachedQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface DetachedQuestion {
  id: string;
  question: string;
  header?: string;
  options: DetachedQuestionOption[];
  multi: boolean;
  recommended?: number;
}

export interface DetachedQuestionAnswer {
  questionId: string;
  selectedOptions: string[];
  customInput?: string;
}

export type DetachedQuestionDelivery =
  | { status: "waiting" }
  | { status: "delivering"; attemptEntryId: string }
  | { status: "delivered"; attemptEntryId: string; nativeEntryId: string; mode: "steer" | "followUp" }
  | { status: "rejected"; attemptEntryId?: string; message: string }
  | { status: "unknown"; attemptEntryId: string; message: string };

export interface DetachedQuestionSnapshot {
  questionId: string;
  questionEntryId: string;
  originRunId: string;
  openedAt: number;
  questions: DetachedQuestion[];
  status: "open" | "accepted" | "closed";
  acceptance?: { commandId: string; acceptanceEntryId: string; acceptedAt: number; answers: DetachedQuestionAnswer[] };
  close?: { closeEntryId: string; closedAt: number; reason: "origin-ended" | "reopen-repair" };
  delivery: DetachedQuestionDelivery;
}

export interface DetachedQuestionsSnapshot {
  protocolVersion: 1;
  hostId: string;
  sessionId: string;
  questions: DetachedQuestionSnapshot[];
}

export function parseDetachedQuestionsSnapshot(value: unknown): DetachedQuestionsSnapshot {
  const source = record(value, 'detached questions snapshot');
  if (source.protocolVersion !== 1 || !Array.isArray(source.questions) || source.questions.length > 4096) throw new Error('Invalid detached question snapshot protocol or size');
  const questionIds = new Set<string>();
  const questions = source.questions.map(item => {
    const entry = record(item, 'detached question snapshot');
    const questionId = text(entry.questionId, 'question identity');
    if (questionIds.has(questionId)) throw new Error('Duplicate detached question identity');
    questionIds.add(questionId);
    const result: DetachedQuestionSnapshot = { questionId, questionEntryId: text(entry.questionEntryId, 'question entry identity'), originRunId: text(entry.originRunId, 'origin run identity'),
      openedAt: time(entry.openedAt), questions: parseDetachedQuestions(entry.questions), status: entry.status as DetachedQuestionSnapshot['status'], delivery: { status: 'waiting' } };
    if (!['open', 'accepted', 'closed'].includes(result.status)) throw new Error('Invalid detached question state');
    if (result.status === 'accepted') {
      const acceptance = record(entry.acceptance, 'question acceptance');
      result.acceptance = { commandId: text(acceptance.commandId, 'acceptance command'), acceptanceEntryId: text(acceptance.acceptanceEntryId, 'acceptance entry'), acceptedAt: time(acceptance.acceptedAt), answers: parseDetachedQuestionAnswers(acceptance.answers, result.questions) };
    } else if (result.status === 'closed') {
      const close = record(entry.close, 'question close');
      if (close.reason !== 'origin-ended' && close.reason !== 'reopen-repair') throw new Error('Invalid detached close reason');
      result.close = { closeEntryId: text(close.closeEntryId, 'close entry'), closedAt: time(close.closedAt), reason: close.reason };
    }
    const delivery = record(entry.delivery, 'question delivery');
    if (delivery.status === 'delivering') {
      if (result.status !== 'accepted') throw new Error('Only accepted answers can be delivering');
      result.delivery = { status: 'delivering', attemptEntryId: text(delivery.attemptEntryId, 'detached delivery attempt identity') };
    } else if (delivery.status !== 'waiting') {
      if (result.status !== 'accepted') throw new Error('Only accepted answers can have delivery receipts');
      const receipt = parseDetachedQuestionDeliveryReceipt({ ...delivery, questionId, outcome: delivery.status });
      const { outcome, questionId: _questionId, ...fields } = receipt;
      result.delivery = { ...fields, status: outcome } as DetachedQuestionDelivery;
    }
    return result;
  });
  return { protocolVersion: 1, hostId: text(source.hostId, 'question host'), sessionId: text(source.sessionId, 'question session'), questions };
}

function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid detached question timestamp');
  return value;
}

export interface ResolveDetachedQuestionRequest {
  questionId: string;
  questionEntryId: string;
  commandId: string;
  answers: DetachedQuestionAnswer[];
}

export interface ResolveDetachedQuestionReceipt {
  questionId: string;
  acceptanceEntryId: string;
  delivery: "waiting";
}

/** Same content representation is used by the shared draft and answer command. */
export function detachedAnswerDraft(answers: DetachedQuestionAnswer[]): string {
  return JSON.stringify(parseDetachedQuestionAnswers(answers));
}

export type DetachedQuestionDeliveryReceipt =
  | { questionId: string; outcome: "delivered"; attemptEntryId: string; nativeEntryId: string; mode: "steer" | "followUp" }
  | { questionId: string; outcome: "rejected"; message: string; attemptEntryId?: string }
  | { questionId: string; outcome: "unknown"; message: string; attemptEntryId: string };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = MAX_SHORT): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}
function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, label, max);
}

export function parseDetachedQuestions(value: unknown): DetachedQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("Detached questions require one to three questions");
  const ids = new Set<string>();
  return value.map((item, questionIndex) => {
    const source = record(item, `detached question ${questionIndex + 1}`);
    const id = text(source.id, "detached question id");
    if (ids.has(id)) throw new Error("Detached question ids must be unique");
    ids.add(id);
    if (!Array.isArray(source.options) || source.options.length > MAX_OPTIONS) throw new Error("Invalid detached question options");
    const labels = new Set<string>();
    const options = source.options.map((item, optionIndex) => {
      const option = record(item, `detached option ${optionIndex + 1}`);
      const label = text(option.label, "detached option label");
      if (labels.has(label)) throw new Error("Detached option labels must be unique within a question");
      labels.add(label);
      return { label, ...(optionalText(option.description, "detached option description", 2_000) === undefined ? {} : { description: optionalText(option.description, "detached option description", 2_000) }),
        ...(optionalText(option.preview, "detached option preview", 2_000) === undefined ? {} : { preview: optionalText(option.preview, "detached option preview", 2_000) }) };
    });
    const recommended = source.recommended;
    if (recommended !== undefined && recommended !== null && (!Number.isInteger(recommended) || (recommended as number) < 0 || (recommended as number) >= options.length)) throw new Error("Invalid detached recommended option");
    return { id, question: text(source.question, "detached question text", MAX_QUESTION),
      ...(optionalText(source.header, "detached question header", MAX_SHORT) === undefined ? {} : { header: optionalText(source.header, "detached question header", MAX_SHORT) }),
      options, multi: source.multi === true, ...(typeof recommended === "number" ? { recommended } : {}) };
  });
}

export function parseDetachedQuestionAnswers(value: unknown, questions?: readonly DetachedQuestion[]): DetachedQuestionAnswer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("Invalid detached question answers");
  const byId = new Map(questions?.map(question => [question.id, question]));
  const ids = new Set<string>();
  const answers = value.map((item, index) => {
    const source = record(item, `detached answer ${index + 1}`), questionId = text(source.questionId, "detached answer question id");
    if (ids.has(questionId)) throw new Error("Detached answers must be unique");
    ids.add(questionId);
    if (!Array.isArray(source.selectedOptions) || source.selectedOptions.length > MAX_OPTIONS || !source.selectedOptions.every(item => typeof item === "string" && item.length > 0 && item.length <= MAX_SHORT)) throw new Error("Invalid detached selected options");
    const selectedOptions = [...new Set(source.selectedOptions as string[])];
    if (selectedOptions.length !== source.selectedOptions.length) throw new Error("Detached selected options must be unique");
    const customInput = optionalText(source.customInput, "detached custom answer", MAX_TEXT);
    const question = byId.get(questionId);
    if (questions && !question) throw new Error("Detached answer does not match this question set");
    if (question) {
      const labels = new Set(question.options.map(option => option.label));
      if (selectedOptions.some(label => !labels.has(label))) throw new Error("Detached answer contains an unknown option");
      if (!question.multi && selectedOptions.length > 1) throw new Error("Detached answer selected multiple options for a single-choice question");
    }
    return { questionId, selectedOptions, ...(customInput === undefined ? {} : { customInput }) };
  });
  if (questions && (answers.length !== questions.length || questions.some(question => !ids.has(question.id)))) throw new Error("Detached answers must cover every question");
  return answers;
}

export function parseResolveDetachedQuestionRequest(value: unknown): ResolveDetachedQuestionRequest {
  const source = record(value, "detached question resolution");
  return { questionId: text(source.questionId, "detached question identity"), questionEntryId: text(source.questionEntryId, "detached question entry identity"),
    commandId: text(source.commandId, "detached question command identity"), answers: parseDetachedQuestionAnswers(source.answers) };
}

export function parseDetachedQuestionDeliveryReceipt(value: unknown): DetachedQuestionDeliveryReceipt {
  const source = record(value, "detached question delivery receipt"), questionId = text(source.questionId, "detached question identity");
  if (source.outcome === "delivered") {
    if (source.mode !== "steer" && source.mode !== "followUp") throw new Error("Invalid detached question delivery mode");
    return { questionId, outcome: "delivered", attemptEntryId: text(source.attemptEntryId, "detached delivery attempt identity"), nativeEntryId: text(source.nativeEntryId, "native delivery identity"), mode: source.mode };
  }
  if (source.outcome === "rejected") return { questionId, outcome: "rejected", message: text(source.message, "detached delivery message", 2_000), ...(source.attemptEntryId === undefined ? {} : { attemptEntryId: text(source.attemptEntryId, "detached delivery attempt identity") }) };
  if (source.outcome === "unknown") return { questionId, outcome: "unknown", message: text(source.message, "detached delivery message", 2_000), attemptEntryId: text(source.attemptEntryId, "detached delivery attempt identity") };
  throw new Error("Invalid detached question delivery outcome");
}
