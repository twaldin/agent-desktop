import { describe, expect, test } from "bun:test";
import {
  capturePlanReviewAnnotationState,
  formatPlanReviewFeedback,
  joinPlanSections,
  parsePlanSections,
  restorePlanReviewAnnotations,
  resolvePlanReviewLineRow,
  sectionDeletionSpan,
  type PlanReviewDocumentSection,
  type PlanReviewLineContext,
} from "@oh-my-pi/pi-coding-agent/plan-mode/plan-review-document";

const document = (text: string): PlanReviewDocumentSection[] => parsePlanSections(text).map(section => ({ ...section, annotations: [] }));
const contexts = (...text: string[]): PlanReviewLineContext[] => text.map(value => ({ text: value, truncated: false }));

describe("native Plan review document helper", () => {
  test("uses the native byte-preserving outline grammar and nested deletion span", () => {
    const text = "preamble\n# Plan\nbody\n```md\n## fenced\n```\n## Step **one**\na\n### Detail\nb\n## Step two\nc";
    const sections = parsePlanSections(text);
    expect(sections.map(section => [section.level, section.title])).toEqual([
      [0, ""], [1, "Plan"], [2, "Step one"], [3, "Detail"], [2, "Step two"],
    ]);
    expect(joinPlanSections(sections)).toBe(`${text}\n`);
    expect(sectionDeletionSpan(sections, 2)).toEqual([2, 3]);
    expect(sectionDeletionSpan(sections, 0)).toEqual([]);
  });

  test("captures detached path/hash anchors and realigns duplicate headings by ancestry", () => {
    const before = document("# Plan\n## A\n### Same\nbody\n## B\n### Same\nbody\n");
    before[4]!.annotations.push({ note: "keep B", target: { kind: "line", row: 3, context: "target text", contextTruncated: false } });
    const state = capturePlanReviewAnnotationState(before);
    before[4]!.annotations[0]!.note = "mutated";
    expect(state.annotations[0]!.note).toBe("keep B");
    expect(state.annotations[0]!.section.path).toEqual(["Plan", "B", "Same"]);
    expect(state.annotations[0]!.section.contentHash).toMatch(/^\d+:[0-9a-f]+$/);

    const moved = document("# Plan\n## B\n### Same\nbody\n## A\n### Same\nbody\n");
    const restored = restorePlanReviewAnnotations(moved, state, index => index === 2
      ? contexts("other", "target text", "target text") : contexts("other"));
    expect(restored.map(items => items.length)).toEqual([0, 0, 1, 0, 0]);
    expect(restored[2]![0]).toEqual({ note: "keep B", target: { kind: "line", row: 2, context: "target text", contextTruncated: false } });
  });

  test("normalizes native status escapes and truncated line anchors before choosing the nearest row", () => {
    expect(resolvePlanReviewLineRow(4, { text: "\u001b[31mtarget…\u001b[0m", truncated: true }, [
      { text: "target extended", truncated: false },
      { text: "other", truncated: false },
      { text: "target extension", truncated: false },
    ])).toBe(2);
    expect(resolvePlanReviewLineRow(0, { text: "\u0000", truncated: false }, contexts("blank"))).toBe(-1);
  });

  test("rejects changed anchored sections while preserving legacy index/title restoration", () => {
    const current = document("# Plan\n## Step\nchanged\n");
    const captured = capturePlanReviewAnnotationState(document("# Plan\n## Step\noriginal\n"));
    captured.annotations.push({ section: { index: 1, title: "Step", path: ["Plan", "Step"], contentHash: "wrong" }, target: { kind: "section" }, note: "stale" });
    expect(restorePlanReviewAnnotations(current, captured, () => contexts("changed"))).toEqual([[], []]);

    const legacy = { annotations: [{ section: { index: 1, title: "Step" }, target: { kind: "section" as const }, note: " legacy " }] };
    expect(restorePlanReviewAnnotations(current, legacy, () => contexts("changed"))[1]).toEqual([{ note: "legacy", target: { kind: "section" } }]);
  });

  test("formats exact native deletion, line, and multiline refinement feedback", () => {
    const sections = document("preamble\n# Plan\nbody\n");
    sections[0]!.annotations.push({ note: "preamble note", target: { kind: "section" } });
    sections[1]!.annotations.push({ note: "Use ``` inside\nand continue", target: { kind: "line", row: 1, context: "body", contextTruncated: false } });
    expect(formatPlanReviewFeedback(sections, ["Old", "Nested"])).toBe(
      "Refinement feedback on the plan:\n\nRemove these sections:\n- Old\n- Nested\n\n## Plan preamble\n- preamble note\n\n## Plan\n> Line: body\n````md\nUse ``` inside\nand continue\n````\n",
    );
    expect(formatPlanReviewFeedback(document("# Empty\n"), [])).toBe("");
  });
});
