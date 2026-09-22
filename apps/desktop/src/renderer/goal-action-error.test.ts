import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import type { Draft } from "@agent-desktop/shared";
import { DraftController } from "./drafts";
import * as errors from "./action-error";
import { goalBudgetIssue, goalComposerCommand } from "./goal-composer";

const app = readFileSync(process.env.GOAL_ACTION_ERROR_APP ?? new URL("./App.tsx", import.meta.url), "utf8");
const owner = { hostId: "home", draftId: "goal-draft" };
const original: Draft = { id: owner.draftId, revision: 1, updatedAt: 1, projectId: null, text: "Keep the objective", model: null, goal: { tokenBudget: "12x" } };
const budgetError = { message: goalBudgetIssue("12x")!, goalBudget: owner };
function harness(initial: errors.ActionError | null = budgetError) {
  let current = initial;
  const drafts = new DraftController(async () => { throw new Error("Unexpected host write"); }, owner.hostId);
  drafts.get(original.id, original);
  const setActionErrorState = (next: errors.ActionError | null | ((value: errors.ActionError | null) => errors.ActionError | null)) => { current = typeof next === "function" ? next(current) : next; };
  const values = { React, GoalComposerIntent: () => null, ...errors, goalBudgetIssue, goalComposerCommand, drafts, ...owner, draft: original,
    selected: null, busy: false, pendingSubmission: undefined, textarea: { current: { focus() {} } }, setActionErrorState };
  const render = () => {
    const start = app.indexOf("<GoalComposerIntent key=");
    const end = app.indexOf("/>", start) + 2;
    if (start < 0 || end < 2) throw new Error("Missing actual App Goal intent");
    const source = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; return (${app.slice(start, end)}); }`);
    return new Function(`${source}; return build;`)()(values).props;
  };
  return { values, drafts, render, error: () => current };
}

test("actual Goal clear retains the objective and dismisses only its owned budget error", () => {
  const h = harness(); h.render().onClear();
  expect(h.drafts.get(original.id).draft.text).toBe(original.text);
  expect(h.drafts.get(original.id).draft.goal).toBeNull();
  expect(h.error()).toBeNull();
});

test("actual Goal edit retains the error for invalid input and clears it after correction", () => {
  const h = harness();
  h.render().onChange({ tokenBudget: "0" }); expect(h.error()).toEqual(budgetError);
  h.render().onChange({ tokenBudget: "500" }); expect(h.error()).toBeNull();
  expect(h.drafts.get(original.id).draft).toMatchObject({ text: original.text, goal: { tokenBudget: "500" } });
});

test("actual Goal recovery preserves unrelated and differently owned errors, even with identical wording", () => {
  for (const current of [errors.actionError(budgetError.message), { ...budgetError, goalBudget: { ...owner, hostId: "other" } }, { ...budgetError, goalBudget: { ...owner, draftId: "other" } }, errors.actionError("Force delivery uncertain", { hostId: owner.hostId, sessionId: "session", commandId: "force" })]) {
    const h = harness(current); h.render().onChange({ tokenBudget: "" }); expect(h.error()).toEqual(current);
    h.render().onClear(); expect(h.error()).toEqual(current);
  }
});

test("actual App refuses an invalid budget locally, but never replaces an uncertain submission with the edited draft", async () => {
  const h = harness(null);
  let uncertain = false, reachedOriginalSubmission = false;
  const boundary = new Error("Original submission boundary");
  const values = { ...h.values, submitting: { current: false }, canSend: true, selectedId: "session",
    submissions: { get: () => uncertain ? { uncertain: true } : undefined },
    draftBrowserOwners: { beforeSubmission() { reachedOriginalSubmission = true; throw boundary; } } };
  const start = app.indexOf("  async function submit("), end = app.indexOf("  async function ", start + 10);
  if (start < 0 || end < 0) throw new Error("Missing actual App submit handler");
  const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(`function build(values) { const {${Object.keys(values).join(",")}} = values; ${app.slice(start, end)} return submit; }`);
  const submit = new Function(`${source}; return build;`)()(values);
  await submit();
  expect(h.error()?.message).toBe(budgetError.message);
  expect(reachedOriginalSubmission).toBe(false);
  h.render().onChange({ tokenBudget: "" });
  expect(h.error()).toBeNull();
  h.drafts.update(original.id, { goal: { tokenBudget: "12x" } });
  uncertain = true;
  await expect(submit()).rejects.toBe(boundary);
  expect(reachedOriginalSubmission).toBe(true);
  expect(h.error()).toBeNull();
});
