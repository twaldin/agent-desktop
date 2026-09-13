import { describe, expect, test } from "bun:test";
import {
  PLAN_REVIEW_ANNOTATION_MAX_BYTES,
  PlanReviewDocumentOwner,
  combinePlanReviewFeedback,
} from "@oh-my-pi/pi-coding-agent/plan-mode/plan-review-document";

const content = [
  "Intro before the title.",
  "# Delivery plan",
  "Opening paragraph with enough words to wrap differently at narrow and wide native render widths.",
  "## Build",
  "Build the exact native document owner.",
  "### Tests",
  "Exercise the rendered row identities.",
  "## Ship",
  "Publish only after review.",
  "",
].join("\n");

function owner() {
  return new PlanReviewDocumentOwner(content, { binding: "review-owner-1" });
}

describe("native Plan review document owner", () => {
  test("projects the native ToC and width/revision-bound rendered rows", () => {
    const document = owner();
    const narrow = document.summary(document.documentRevision, 40);
    expect(narrow.sections.map(section => [section.level, section.title])).toEqual([
      [0, ""], [1, "Delivery plan"], [2, "Build"], [3, "Tests"], [2, "Ship"],
    ]);
    expect(narrow.toc).toEqual(narrow.sections.slice(2).map(section => section.sectionId));

    const title = document.section(document.documentRevision, narrow.sections[1]!.sectionId, 40);
    expect(title.rows.length).toBeGreaterThan(2);
    expect(title.rows.every(row => row.rowId.length === 64 && /^[a-f0-9]+$/.test(row.rowId))).toBe(true);
    const wide = document.summary(document.documentRevision, 100);
    expect(wide.sections[1]!.sectionId).not.toBe(narrow.sections[1]!.sectionId);
    expect(() => document.section(document.documentRevision, narrow.sections[1]!.sectionId, 100)).toThrow("section changed");
    expect(() => document.summary("0".repeat(64), 40)).toThrow("document changed");
    expect(() => document.summary(document.documentRevision, 19)).toThrow("from 20 to 240");
  });

  test("prepares section and rendered-line annotations without mutating the original owner", () => {
    const document = owner();
    const summary = document.summary(document.documentRevision, 54);
    const buildId = summary.sections.find(section => section.title === "Build")!.sectionId;
    const build = document.section(document.documentRevision, buildId, 54);
    const line = build.rows.find(row => row.text.includes("exact native"))!;

    const sectionPrepared = document.prepare({ kind: "annotate", expectedDocumentRevision: document.documentRevision,
      target: { kind: "section", sectionId: buildId }, note: "Keep this bounded." }, 54);
    expect(document.feedback).toBe("");
    expect(sectionPrepared.result.artifactChanged).toBe(false);
    expect(sectionPrepared.result.documentRevision).not.toBe(document.documentRevision);

    const nextSummary = sectionPrepared.next.summary(sectionPrepared.next.documentRevision, 54);
    const nextBuildId = nextSummary.sections.find(section => section.title === "Build")!.sectionId;
    const nextBuild = sectionPrepared.next.section(sectionPrepared.next.documentRevision, nextBuildId, 54);
    expect(nextBuild.annotations[0]).toMatchObject({ note: "Keep this bounded.", target: { kind: "section" } });
    expect(nextBuild.rows.every(row => row.annotationIds.length === 0)).toBe(true);

    const nextLine = nextBuild.rows.find(row => row.text === line.text)!;
    const linePrepared = sectionPrepared.next.prepare({ kind: "annotate",
      expectedDocumentRevision: sectionPrepared.next.documentRevision,
      target: { kind: "line", sectionId: nextBuildId, rowId: nextLine.rowId }, note: "Clarify this line." }, 54);
    const finalSummary = linePrepared.next.summary(linePrepared.next.documentRevision, 54);
    const finalBuildId = finalSummary.sections.find(section => section.title === "Build")!.sectionId;
    const finalBuild = linePrepared.next.section(linePrepared.next.documentRevision, finalBuildId, 54);
    const lineAnnotation = finalBuild.annotations.find(annotation => annotation.target.kind === "line")!;
    const lineRowId = lineAnnotation.target.kind === "line" ? lineAnnotation.target.rowId : "";
    expect(finalBuild.rows.find(row => row.rowId === lineRowId)?.annotationIds)
      .toEqual([lineAnnotation.annotationId]);
    expect(linePrepared.result.feedback).toContain("> Line: Build the exact native document owner.");
    expect(() => document.prepare({ kind: "annotate", expectedDocumentRevision: document.documentRevision,
      target: { kind: "section", sectionId: buildId }, note: "x".repeat(PLAN_REVIEW_ANNOTATION_MAX_BYTES + 1) }, 54))
      .toThrow("annotation is too large");
  });

  test("deletes descendants transactionally and native undo restores exact bytes and annotations", () => {
    const document = owner();
    const first = document.summary(document.documentRevision, 80);
    const buildId = first.sections.find(section => section.title === "Build")!.sectionId;
    const annotated = document.prepare({ kind: "annotate", expectedDocumentRevision: document.documentRevision,
      target: { kind: "section", sectionId: buildId }, note: "Retain on undo." }, 80).next;
    const annotatedSummary = annotated.summary(annotated.documentRevision, 80);
    const annotatedBuildId = annotatedSummary.sections.find(section => section.title === "Build")!.sectionId;
    const removed = annotated.prepare({ kind: "delete-section", expectedDocumentRevision: annotated.documentRevision,
      sectionId: annotatedBuildId }, 80);
    expect(annotated.content).toBe(content);
    expect(removed.result.content).not.toContain("## Build");
    expect(removed.result.content).not.toContain("### Tests");
    expect(removed.result.content).toContain("## Ship");
    expect(removed.result.feedback).toContain("- Build\n- Tests\n");
    expect(removed.result.artifactChanged).toBe(true);

    const restored = removed.next.prepare({ kind: "undo", expectedDocumentRevision: removed.next.documentRevision }, 80);
    expect(restored.result.content).toBe(content);
    expect(restored.result.feedback).toContain("Retain on undo.");
    expect(restored.result.feedback).not.toContain("Remove these sections");
    expect(restored.result.artifactChanged).toBe(true);
  });

  test("replace realigns annotations and clears native undo/deletion history", () => {
    const document = owner();
    const summary = document.summary(document.documentRevision, 70);
    const shipId = summary.sections.find(section => section.title === "Ship")!.sectionId;
    const annotated = document.prepare({ kind: "annotate", expectedDocumentRevision: document.documentRevision,
      target: { kind: "section", sectionId: shipId }, note: "Retained note." }, 70).next;
    const moved = content.replace("## Ship\nPublish only after review.\n", "## Later\nOther.\n## Ship\nPublish only after review.\n");
    const replaced = annotated.prepareReplace({ content: moved, expectedDocumentRevision: annotated.documentRevision, renderColumns: 70 });
    expect(replaced.result.summary.canUndo).toBe(false);
    expect(replaced.result.feedback).toContain("Retained note.");
    expect(() => replaced.next.prepare({ kind: "undo", expectedDocumentRevision: replaced.next.documentRevision }, 70)).toThrow("no native Plan document action");

    const changed = moved.replace("Publish only after review.", "Publish after a different review.");
    const changedResult = replaced.next.prepareReplace({ content: changed,
      expectedDocumentRevision: replaced.next.documentRevision, renderColumns: 70 });
    expect(changedResult.result.feedback).toBe("");
  });

  test("native composition preserves the exact structured block when no additional feedback exists", () => {
    const generated = "Refinement feedback on the plan:\n\n## Build\n- Clarify.\n";
    expect(combinePlanReviewFeedback(generated, "")).toBe(generated);
    expect(combinePlanReviewFeedback("", "Please add dates.\n")).toBe("Please add dates.\n");
    expect(combinePlanReviewFeedback(generated, "Please add dates.\n"))
      .toBe("Refinement feedback on the plan:\n\n## Build\n- Clarify.\n\nPlease add dates.\n");
  });

  test("refuses an unprojectable prepared annotation without changing the adopted owner", () => {
    let document = owner();
    const note = "n".repeat(300_000);
    let refused = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const summary = document.summary(document.documentRevision, 60);
      const buildId = summary.sections.find(section => section.title === "Build")!.sectionId;
      const beforeRevision = document.documentRevision;
      try {
        document = document.prepare({ kind: "annotate", expectedDocumentRevision: beforeRevision,
          target: { kind: "section", sectionId: buildId }, note }, 60).next;
      } catch (error) {
        expect((error as Error).message).toContain("summary is too large");
        expect(document.documentRevision).toBe(beforeRevision);
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    expect(document.summary(document.documentRevision, 60).feedback.length).toBeLessThan(2 * 1024 * 1024);
  });
});
