import { expect, test } from "bun:test";
import { parseDetachedQuestionAnswers, parseDetachedQuestionDeliveryReceipt, parseDetachedQuestions, parseDetachedQuestionsSnapshot, parseResolveDetachedQuestionRequest } from "./detached-questions";

test("detached question parsers retain only bounded canonical fields", () => {
  const questions = parseDetachedQuestions([{ id: "density", question: "Which density?", header: null, multi: false, recommended: 1,
    options: [{ label: "Comfortable", description: null, preview: null }, { label: "Compact", extra: "discard" }], extra: true }]);
  expect(questions).toEqual([{ id: "density", question: "Which density?", multi: false, recommended: 1,
    options: [{ label: "Comfortable" }, { label: "Compact" }] }]);
  expect(parseDetachedQuestionAnswers([{ questionId: "density", selectedOptions: ["Compact"], customInput: "because" }], questions))
    .toEqual([{ questionId: "density", selectedOptions: ["Compact"], customInput: "because" }]);
  expect(parseResolveDetachedQuestionRequest({ questionId: "q", questionEntryId: "e", commandId: "c", answers: [{ questionId: "density", selectedOptions: [] }], ignored: true }))
    .toEqual({ questionId: "q", questionEntryId: "e", commandId: "c", answers: [{ questionId: "density", selectedOptions: [] }] });
  expect(parseDetachedQuestionDeliveryReceipt({ questionId: "q", outcome: "delivered", attemptEntryId: "a", nativeEntryId: "n", mode: "followUp", ignored: true }))
    .toEqual({ questionId: "q", outcome: "delivered", attemptEntryId: "a", nativeEntryId: "n", mode: "followUp" });
  expect(parseDetachedQuestionsSnapshot({ protocolVersion: 1, hostId: "host", sessionId: "session", questions: [{
    questionId: "q", questionEntryId: "entry", originRunId: "run", openedAt: 1, questions, status: "accepted",
    acceptance: { commandId: "command", acceptanceEntryId: "accepted", acceptedAt: 2, answers: [{ questionId: "density", selectedOptions: ["Compact"] }] },
    delivery: { status: "delivering", attemptEntryId: "attempt", ignored: true },
  }] }).questions[0]?.delivery).toEqual({ status: "delivering", attemptEntryId: "attempt" });
});

test("detached question parsers reject ambiguous answers and invalid receipts", () => {
  const questions = parseDetachedQuestions([{ id: "one", question: "One?", options: [{ label: "A" }, { label: "B" }], multi: false }]);
  expect(() => parseDetachedQuestionAnswers([{ questionId: "one", selectedOptions: ["A", "B"] }], questions)).toThrow();
  expect(() => parseDetachedQuestionAnswers([{ questionId: "other", selectedOptions: [] }], questions)).toThrow();
  expect(() => parseDetachedQuestionDeliveryReceipt({ questionId: "q", outcome: "unknown", message: "lost" })).toThrow();
});
