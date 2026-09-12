const { app, BrowserWindow } = require("electron");
const { chmodSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const output = process.argv[2], repo = process.argv[3];
app.setAppPath(join(repo, "apps/desktop"));
const fixture = JSON.parse(readFileSync(join(output, "launch.json"), "utf8"));
const result = { passed: false, scope: "Actual production Electron main/preload/App/Pierre plus actual isolated host and Git repository. No provider prompts.", checks: [], captures: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 110000;
let window;
async function until(expression) {
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript(expression);
    if (value) return value;
    await pause(50);
  }
  throw new Error(`App acceptance timed out: ${expression}`);
}
async function capture(name) {
  const file = join(output, `${name}.png`);
  writeFileSync(file, (await window.webContents.capturePage()).toPNG());
  result.captures.push(file);
}
async function click(text) {
  const expression = `gitFileFixtureButton(${JSON.stringify(text)})`;
  await until(`${expression} !== null`);
  await window.webContents.executeJavaScript(`${expression}.click()`);
}
async function refreshRevision(expression) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[aria-label="Git file revision"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(expression)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await click("Refresh");
  await until("document.querySelector('.workspace-git-file')?.getAttribute('aria-busy') === 'false'");
}
async function run() {
  try {
    await app.whenReady();
    while (Date.now() < deadline) {
      window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes("index.html") && !candidate.webContents.isLoading());
      if (window) break;
      await pause(50);
    }
    if (!window) throw new Error("Production App window was not created");
    await window.webContents.executeJavaScript(`
      window.gitFileFixtureButton = text => [...document.querySelectorAll('button')].find(button => button.getClientRects().length && !button.closest('[hidden]') && button.textContent.trim() === text) ?? null;
      window.gitFileFixtureEditor = () => [...document.querySelectorAll('diffs-container')].flatMap(container => [...(container.shadowRoot?.querySelectorAll('[contenteditable="true"]') ?? [])]).find(element => element.getClientRects().length) ?? null;
      window.gitFileFixtureReadOnlyText = () => [...document.querySelectorAll('.workspace-git-revision diffs-container')].map(container => container.shadowRoot?.textContent ?? '').join('');
      true;
    `);
    await until("gitFileFixtureEditor() !== null");
    await click("Git blame and history");
    await until("document.querySelector('.workspace-git-file-history')?.textContent.includes('Rename the selected source')");
    await until("document.querySelector('.workspace-git-file')?.dataset.repositoryWatch === 'ready'");
    await until("document.querySelector('.workspace-git-file')?.getAttribute('aria-busy') === 'false'");
    await click("Refresh");
    await until("document.querySelector('.workspace-git-file')?.getAttribute('aria-busy') === 'false'");
    result.checks.push("Actual App file tab loaded original repository history through production transport");
    await window.webContents.executeJavaScript(`(() => { const input = gitFileFixtureEditor(); input.focus(); const range = document.createRange(); range.selectNodeContents(input); range.collapse(true); const selection = input.getRootNode().getSelection?.() ?? document.getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await until("document.querySelector('.pierre-git-active-blame')?.textContent.includes('First Author')");
    await capture("actual-app-clean-active-line-blame");
    await window.webContents.insertText("GIT_FILE_DIRTY_MARKER");
    await until("gitFileFixtureEditor()?.textContent.includes('GIT_FILE_DIRTY_MARKER')");
    await until("document.querySelector('.pierre-git-active-blame')?.textContent.includes('differs')");
    result.checks.push("Native edit disables misleading committed line attribution");
    await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('.workspace-git-file-history li > button:first-child')].find(button => button.textContent.includes('Initial file contents')); if (!button) throw new Error('Initial commit row missing'); button.click(); })()`);
    await until(`document.querySelector('.workspace-git-revision header')?.textContent.includes(${JSON.stringify(fixture.first.slice(0, 8))})`);
    await until("gitFileFixtureReadOnlyText().includes('line60 = 60')");
    assert.equal(await window.webContents.executeJavaScript("gitFileFixtureEditor() === null"), true, "Historical source must not be editable");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.workspace-git-revision')?.dataset.symbolNavigation"), "unavailable");
    await capture("actual-app-original-path-immutable-revision");
    result.checks.push("Real first commit opens at original pre-rename path without a working editor");
    await window.webContents.executeJavaScript("document.querySelector('.workspace-git-revision-blame').open = true");
    await until("document.querySelector('.workspace-git-revision-blame li button') !== null");
    await window.webContents.executeJavaScript("document.querySelectorAll('.workspace-git-revision-blame li button')[59].click()");
    await until("document.querySelector('.workspace-git-revision diffs-container')?.shadowRoot?.activeElement?.getAttribute('data-line') === '60'");
    result.checks.push("Blame origin opens and reveals its 1-based original line in read-only Pierre");
    for (const [name, width, height, zoom] of [["narrow", 820, 850, 1], ["zoom", 1120, 900, 1.25]]) {
      window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); await pause(100); await capture(`actual-app-${name}-immutable-revision`);
    }
    await click("Return to working file");
    await until("gitFileFixtureEditor()?.textContent.includes('GIT_FILE_DIRTY_MARKER')");
    result.checks.push("Returning restores the original native working document and edited text");
    await window.webContents.executeJavaScript("gitFileFixtureEditor().focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["meta"] }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["meta"] });
    await until("gitFileFixtureEditor() && !gitFileFixtureEditor().textContent.includes('GIT_FILE_DIRTY_MARKER')");
    result.checks.push("Native undo history survives immutable Git navigation");
    window.setContentSize(1120, 900); window.webContents.setZoomFactor(1);
    const workingPath = join(fixture.cwd, "src/renamed.ts");
    chmodSync(workingPath, 0);
    try {
      await refreshRevision("HEAD");
      await until("document.querySelector('.workspace-git-file')?.textContent.includes('Permission denied reading the working file')");
      await click("Inspect committed snapshot");
      await until("gitFileFixtureReadOnlyText().includes('line60 = 600')");
      await capture("actual-app-denied-working-readable-history");
      result.checks.push("Denied working file is explicit while committed history remains readable in actual App");
      await click("Return to working file");
    } finally { chmodSync(workingPath, 0o644); }
    for (const [name, message] of [["binary", "Binary revisions do not have text blame."], ["encoding", "This revision's encoding is unsupported."], ["oversized", "This revision exceeds the host text limit."]]) {
      await refreshRevision(fixture.cases[name]);
      await until(`document.querySelector('.workspace-git-file')?.textContent.includes(${JSON.stringify(message)})`);
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.workspace-git-revision') === null"), true, "Reason must appear before selecting a revision");
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.workspace-git-file-history')?.textContent.includes('Working/editor text differs')"), false);
      await capture(`actual-app-${name}-reason-before-selection`);
      result.checks.push(`Actual App ${name} reason is visible before immutable selection without false dirty attribution`);
    }
    await refreshRevision(fixture.cases.merge);
    await until("document.querySelector('.workspace-git-file-history')?.textContent.includes('App merged side change')");
    await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.workspace-git-file-history li > button:first-child')].find(button => button.textContent.includes('App merged side change'));
      button.click();
    })()`);
    await until(`document.querySelector('.workspace-git-revision header')?.textContent.includes(${JSON.stringify(fixture.cases.side.slice(0, 8))})`);
    await until("gitFileFixtureReadOnlyText().includes('mergedSide')");
    await capture("actual-app-merged-side-immutable-revision");
    result.checks.push("Merged side commit appears in actual App history and opens its matching immutable contents");
    await click("Return to working file");
    await refreshRevision(fixture.cases.sparse);
    await until("document.querySelector('.workspace-git-file-history')?.textContent.includes('No file changes in the scanned history page')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.workspace-git-file-history')?.textContent.includes('untracked')"), false);
    await capture("actual-app-bounded-empty-history-page");
    await click("Load more file history");
    await until("document.querySelector('.workspace-git-file-history')?.textContent.includes('Initial file contents')");
    await capture("actual-app-bounded-history-continued");
    result.checks.push("Bounded empty page is not mislabeled untracked and actual App continuation reaches real file history");
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    if (window) { result.dom = await window.webContents.executeJavaScript("document.body.innerText").catch(() => "Unavailable"); await capture("failure").catch(() => {}); }
  } finally {
    writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
    app.exit(result.passed ? 0 : 1);
  }
}
// Runtime-selected built production entry; the fixture does not recreate App or its bridge.
require(join(repo, "apps/desktop/dist/main.cjs"));
void run();
