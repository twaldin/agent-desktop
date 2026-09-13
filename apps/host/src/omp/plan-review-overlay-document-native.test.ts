import { expect, test } from "bun:test";
import { PlanReviewOverlay } from "@oh-my-pi/pi-coding-agent/modes/components/plan-review-overlay";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

initThemeSync();

test("native PlanReviewOverlay uses the document owner for delete, undo, and annotations", () => {
  const edits: string[] = [], feedback: string[] = [], states: unknown[] = [];
  const original = "# Plan\nIntro body.\n## Build\nBuild body.\n### Verify\nVerify body.\n## Ship\nShip body.\n";
  const overlay = new PlanReviewOverlay(original, { options: ["Refine plan"] }, {
    onPick() {}, onCancel() {},
    onPlanEdited: content => edits.push(content),
    onFeedbackChange: value => feedback.push(value),
    onAnnotationStateChange: state => states.push(state),
  });

  overlay.render(100);
  overlay.handleInput("\t"); // actions -> ToC, selected Build
  overlay.handleInput("d");
  expect(edits.at(-1)).toBe("# Plan\nIntro body.\n## Ship\nShip body.\n");
  expect(feedback.at(-1)).toContain("- Build\n- Verify\n");

  overlay.render(100);
  overlay.handleInput("u");
  expect(edits.at(-1)).toBe(original);
  expect(feedback.at(-1)).toBe("");

  overlay.render(100);
  overlay.handleInput("a");
  overlay.handleInput("Keep this section");
  overlay.handleInput("\r");
  expect(feedback.at(-1)).toBe("Refinement feedback on the plan:\n\n## Build\n- Keep this section\n");
  expect(states.length).toBeGreaterThan(0);

  overlay.render(100);
  overlay.handleInput("\t"); // ToC -> body
  overlay.handleInput("a");
  overlay.handleInput("Clarify this row");
  overlay.handleInput("\r");
  expect(feedback.at(-1)).toContain("> Line:");
  expect(feedback.at(-1)).toContain("Clarify this row");
});
