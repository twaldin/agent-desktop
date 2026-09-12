import type { BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Actual App + authenticated host + SQLite + controlled native gh child; no GitHub writes. */
export async function runPullRequestWriteFlow({ window, fixture, evaluate, wait, click, capture, checkpoints }: {
  window: BrowserWindow; fixture: string; evaluate(script: string): Promise<any>;
  wait(expression: string, label: string): Promise<void>; click(selector: string, text?: string): Promise<void>;
  capture(name: string): Promise<void>; checkpoints: string[];
}) {
  const log = join(fixture, "gh-written.jsonl"), control = join(fixture, "gh-write-control.json");
  const writes = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const comment = '.pull-request-discussion textarea';
  const type = async (selector: string, value: string) => {
    await click(selector); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await window.webContents.insertText(value);
    await wait(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`, "typed draft");
  };
  await wait(`!!document.querySelector(${JSON.stringify(comment)})&&!document.querySelector(${JSON.stringify(comment)}).disabled`, "comment composer available");
  await type(comment, "Saved original comment\nwith a second line");
  await wait(`pullRequestsAppState().saved.state.pullRequestComposers?.some(entry=>entry.body==='Saved original comment\\nwith a second line')`, "comment draft saved");
  const original = await evaluate("pullRequestsAppState().documentId");
  window.webContents.reload();
  await wait(`pullRequestsAppState().documentId!==${JSON.stringify(original)}&&document.querySelector(${JSON.stringify(comment)})?.value==='Saved original comment\\nwith a second line'`, "draft survives actual reload");
  if (writes().length) throw new Error("Reload posted a draft");
  await wait(`!document.querySelector('.pull-request-discussion button[type=submit]')?.disabled`, "account revalidated");
  await click('.pull-request-discussion button[type=submit]');
  await wait(`document.querySelector(${JSON.stringify(comment)})?.value===''&&document.querySelector('.pull-request-discussion')?.innerText.includes('Saved original comment')`, "posted comment visible and draft cleared");
  if (writes().length !== 1) throw new Error("Comment was not submitted exactly once");
  checkpoints.push("saved-comment-reload-one-post-and-refresh"); await capture("03-posted-comment");
  for (const [decision, body] of [["Comment", "Review only comment"], ["Approve", ""], ["Request changes", "Please fix the review concern"]] as const) {
    await click('.pull-request-heading button', 'Submit review');
    await wait(`!!document.querySelector('[role=dialog] textarea')`, "review dialog");
    await click('[role=dialog] label', decision);
    if (decision === "Request changes") {
      await click('[role=dialog] button[type=submit]');
      await wait(`document.querySelector('[role=dialog] [role=alert]')?.textContent==='Add a comment before requesting changes'`, "required review body");
    }
    if (body) await type('[role=dialog] textarea', body);
    await capture(`review-dialog-${decision.toLowerCase().replaceAll(' ', '-')}`);
    await click('[role=dialog] button[type=submit]');
    await wait(`!document.querySelector('[role=dialog]')`, "successful review closes dialog");
    await wait(`!document.querySelector('.pull-request-discussion button[type=submit]')?.closest('form')?.getAttribute('aria-busy')?.includes('true')`, "review refreshed");
  }
  const reviewed = writes();
  if (reviewed.length !== 4 || reviewed.slice(1).map(value => value.event).join() !== 'COMMENT,APPROVE,REQUEST_CHANGES' || reviewed.slice(1).some(value => value.commit_id !== 'b'.repeat(40))) throw new Error("Review decisions or original commit changed");
  checkpoints.push("three-real-review-events-and-empty-body-validation"); await capture("04-reviews");
  await click('.pull-request-heading button', 'Submit review');
  await wait(`!!document.querySelector('[role=dialog] textarea')`, "review dialog for changed head");
  await type('[role=dialog] textarea', "Head changed preserves this draft"); writeFileSync(control, JSON.stringify({ head: "c".repeat(40) }));
  await click('[role=dialog] button[type=submit]');
  await wait(`document.querySelector('[role=dialog]')?.innerText.includes('Refresh and review')`, "head change rejected");
  if (writes().length !== 4 || await evaluate(`document.querySelector('[role=dialog] textarea').value`) !== "Head changed preserves this draft") throw new Error("Head rejection posted or erased text");
  checkpoints.push("changed-head-rejects-review-before-post-preserves-draft");
  await click('[role=dialog] button', 'Cancel');
  writeFileSync(control, JSON.stringify({ malformed: true }));
  await type(comment, "Ambiguous delivery must not replay");
  await click('.pull-request-discussion button[type=submit]');
  await wait(`document.querySelector('.pull-request-discussion')?.innerText.includes('GitHub may have received')`, "uncertain delivery visible");
  if (writes().length !== 5) throw new Error("Ambiguous attempt count");
  const beforeReload = await evaluate("pullRequestsAppState().documentId"); window.webContents.reload();
  await wait(`pullRequestsAppState().documentId!==${JSON.stringify(beforeReload)}&&document.querySelector('.pull-request-discussion')?.innerText.includes('GitHub may have received')`, "uncertain original survives reopen");
  await wait(`![...document.querySelectorAll('.pull-request-discussion button')].find(button=>button.textContent==='Check submission status')?.disabled`, "status enabled");
  await click('.pull-request-discussion button', 'Check submission status');
  await wait(`document.querySelector('.pull-request-discussion form')?.getAttribute('aria-busy')==='false'`, "status settled");
  if (writes().length !== 5) throw new Error("Status/reopen replayed external action");
  checkpoints.push("ambiguous-delivery-reopen-status-never-replays"); await capture("05-uncertain-preserved");
  writeFileSync(control, "{}");
}
