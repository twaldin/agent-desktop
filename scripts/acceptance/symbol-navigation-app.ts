import type { applyViewport } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { symbolOffset, type SymbolSelection } from "../../packages/shared/src/symbol-navigation";
import { observeOriginalFileEditors } from "./file-editor-commands-app/observe";

// The pinned native browser API owns Puppeteer's dependency and Page type.
type SymbolAcceptancePage = Parameters<typeof applyViewport>[0];

interface SymbolAppSnapshot {
  label: string | null | undefined; text: string | undefined;
  selection: { text: string | undefined; anchor: { line: number; column: number } | null; focus: { line: number; column: number } | null };
  selections: SymbolSelection[]; domSelection: string | undefined;
  messages: Array<string | null>; buttons: Array<{ text: string | null; disabled: boolean }>; choices: number;
}

/** Run against the REAL App page after opening symbol-source.ts from the disposable
 * workspace created by symbol-navigation-fixture.ts. No fake bridge or renderer.
 * The caller owns browser/host lifetime and the explicit private output directory. */
export async function exerciseSymbolNavigationApp(page: SymbolAcceptancePage, output: string, options: { restoredPullRequests?: boolean } = {}) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await readdir(output)).length) throw new Error("Acceptance output must be a new empty directory; frozen evidence is never overwritten.");
  const checks: string[] = [], errors: string[] = [];
  const onError = (error: unknown) => errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  page.on("pageerror", onError);
  const session = await page.createCDPSession();
  const snapshot = async (): Promise<SymbolAppSnapshot> => {
    // The serialized observer reads the original native editor, independently
    // of command eligibility and without manufacturing a caret before focus.
    const response = await session.send("Runtime.evaluate", { returnByValue: true, expression: "(" + observeOriginalFileEditors.toString() + ")()" });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    if (!Array.isArray(response.result.value)) throw new Error("The original-editor observer did not return its observation list.");
    // The protocol loses the return type of this exact serialized local function.
    const observations = response.result.value as ReturnType<typeof observeOriginalFileEditors>;
    const state = observations[0], native = state?.native, selection = native?.selections?.at(-1);
    return { label: state?.label, domSelection: state?.domSelection, messages: state?.messages ?? [], buttons: state?.buttons ?? [], choices: state?.choices ?? 0,
      text: native?.text, selections: native?.selections ?? [], selection: {
      text: native && selection ? native.text.slice(symbolOffset(native.text, selection.start), symbolOffset(native.text, selection.end)) : undefined,
      anchor: selection ? selection.direction === "backward" ? selection.end : selection.start : null,
      focus: selection ? selection.direction === "backward" ? selection.start : selection.end : null,
    } };
  };
  const wait = async (predicate: (state: SymbolAppSnapshot) => boolean, stage = "expected symbol state") => {
    for (let attempt = 0; attempt < 500; attempt++) { const value = await snapshot(); if (predicate(value)) return value; await Bun.sleep(50); }
    throw new Error(`The actual App did not reach ${stage}: ` + JSON.stringify(await snapshot()));
  };
  const waitForEditorFocus = async (label: string) => {
    // Model restoration can precede Pierre's queued focus. A native typing or
    // Undo gesture must reach the visible editor, not the interim document body.
    await page.waitForFunction((label: string) => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return document.hasFocus() && active instanceof HTMLElement && active.isContentEditable
        && active.getAttribute("aria-label") === label && active.getClientRects().length > 0;
    }, { timeout: 5000 }, label);
  };
  const retainSelection = async (text: string, stage: string) => {
    for (let frame = 0; frame < 8; frame++) {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      const selected = await snapshot();
      if (selected.selection.text !== text) throw new Error(`${stage} changed after input: ${JSON.stringify(selected.selection)}`);
    }
  };
  const command = async (id: "file.goToDefinition" | "file.navigateBack" | "file.navigateForward") => {
    await page.keyboard.down("Control");
    try {
      if (id === "file.navigateForward") await page.keyboard.down("Shift");
      try { await page.keyboard.press(id === "file.goToDefinition" ? "BracketRight" : "Minus"); }
      finally { if (id === "file.navigateForward") await page.keyboard.up("Shift"); }
    } finally { await page.keyboard.up("Control"); }
  };
  const hasCommand = async (id: string) => {
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("k"); } finally { await page.keyboard.up(modifier); }
    await page.waitForSelector(".command-menu", { visible: true });
    const exists = await page.evaluate((id: string) => [...document.querySelectorAll("[cmdk-item]")].some(node => node.getAttribute("data-value") === `command:${id}`), id);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".command-menu", { hidden: true });
    return exists;
  };
  const click = async (label: string) => {
    await page.waitForFunction((label: string) => [...document.querySelectorAll<HTMLButtonElement>(".symbol-navigation button")]
      .some(node => node.getClientRects().length && !node.disabled && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label)), { timeout: 5000 }, label);
    const point = await page.evaluate((label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".symbol-navigation button")].find(node => node.getClientRects().length && !node.disabled && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label));
      if (!button) throw new Error("No enabled symbol action: " + label);
      const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, label);
    await page.mouse.click(point.x, point.y);
  };
  const goTo = async (line: number, column: number) => {
    const point = await page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].find(node => node.getClientRects().length);
      const input = frame?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!input) throw new Error("The original native editor input is missing.");
      const rect = input.getBoundingClientRect(); return { x: rect.left + 12, y: rect.top + 12 };
    });
    await page.mouse.click(point.x, point.y);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("l"); } finally { await page.keyboard.up(modifier); }
    const input = await page.waitForSelector('input[aria-label="Go to line"]', { visible: true });
    if (!input) throw new Error("Production GoToLine did not open");
    await page.keyboard.type(String(line)); await page.keyboard.press("Enter");
    for (let offset = 1; offset < column; offset++) await page.keyboard.press("ArrowRight");
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: join(output, name + ".png") });
    await writeFile(join(output, name + ".json"), JSON.stringify(await snapshot(), null, 2));
  };
  try {
    if (options.restoredPullRequests) {
      const close = await page.waitForSelector('button[aria-label="Close pull requests"]', { visible: true });
      if (!close) throw new Error("The restored Pull requests page did not open.");
      const restored = await page.evaluate(() => ({
        initial: window.agentDesktopWindow?.initial,
        editors: [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")]
          .map(frame => ({ visible: Boolean(frame.getClientRects().length),
            label: frame.querySelector("diffs-container")?.shadowRoot?.querySelector('[contenteditable="true"]')?.getAttribute("aria-label") })),
      }));
      if (!restored.initial?.state?.pullRequestsOpen || restored.initial.error || restored.editors.some(editor => editor.visible))
        throw new Error("The file editor was not restored behind the saved Pull requests page.");
      await page.screenshot({ path: join(output, "00-restored-pull-requests.png") });
      await writeFile(join(output, "00-restored-pull-requests.json"), JSON.stringify(restored, null, 2));
      await close.click();
      await wait(value => value.label === "Edit symbol-source.ts");
      checks.push("A new App process restores Pull requests open, then first displays the original file editor when that page closes.");
    }
    await wait(value => value.label === "Edit symbol-source.ts");
    // A retained target misses the first-render focus race. Close the clean
    // disposable target, and require its actual editor to be unmounted.
    const targetClose = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('button[aria-label="Close symbol-target.ts tab"]');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    if (targetClose) await page.mouse.click(targetClose.x, targetClose.y);
    await page.waitForFunction(() => ![...document.querySelectorAll('.pierre-source-editor-frame[data-symbol-owner]')]
      .some(frame => frame.querySelector('diffs-container')?.shadowRoot?.querySelector('[aria-label="Edit symbol-target.ts"]')));
    await goTo(2, 3); const origin = await snapshot();
    if (!origin.selection.anchor || !origin.selection.focus) throw new Error("The real native cursor could not be observed.");
    await command("file.goToDefinition");
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    await capture("01-definition"); checks.push("Real compiler request opens imported declaration in the actual App/Pierre editor.");
    // Let Chromium deliver the queued render/focus/selection events. An initial
    // correct selection is insufficient if the next paint collapses it.
    for (let frame = 0; frame < 8; frame++) {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      const selected = await snapshot();
      if (selected.label !== "Edit symbol-target.ts" || selected.selection.text !== "first")
        throw new Error("First-mounted symbol selection collapsed after render: " + JSON.stringify(selected.selection));
    }
    checks.push("First-mounted declaration selection survives queued editor focus and selection events.");
    const declaration = await snapshot();
    const openPullRequests = await page.waitForSelector('.nav-action[aria-label="Pull requests"]', { visible: true });
    if (!openPullRequests) throw new Error("The production Pull requests action is missing.");
    await openPullRequests.click();
    const closePullRequests = await page.waitForSelector('button[aria-label="Close pull requests"]', { visible: true });
    if (!closePullRequests) throw new Error("The production Pull requests page did not open.");
    await closePullRequests.click();
    await wait(value => value.label === "Edit symbol-target.ts");
    for (let frame = 0; frame < 8; frame++) {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      const restored = await snapshot();
      if (JSON.stringify(restored.selection) !== JSON.stringify(declaration.selection))
        throw new Error("Pull requests navigation changed the retained declaration selection: " + JSON.stringify(restored.selection));
    }
    await capture("01b-definition-after-pull-requests");
    checks.push("Opening and closing the actual Pull requests page preserves the original declaration selection across queued frames.");
    // Retained editors also receive late native selection events after their
    // focus frames. Exercise real history navigation, not just first mount.
    for (let round = 0; round < 30; round++) {
      await command("file.navigateBack");
      await wait(value => value.label === "Edit symbol-source.ts" && JSON.stringify(value.selection) === JSON.stringify(origin.selection));
      await command("file.navigateForward");
      await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
      for (let frame = 0; frame < 8; frame++) {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        const selected = await snapshot();
        if (selected.label !== "Edit symbol-target.ts" || selected.selection.text !== "first")
          throw new Error(`Retained declaration selection collapsed in history round ${round + 1}: ${JSON.stringify(selected.selection)}`);
      }
    }
    checks.push("Thirty real Back/Forward cycles retain the declaration range through subsequent frames.");
    await command("file.navigateBack");
    await wait(value => value.label === "Edit symbol-source.ts" && JSON.stringify(value.selection) === JSON.stringify(origin.selection));
    checks.push("Back restores the exact original native cursor and selection.");
    await command("file.navigateForward"); await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    await command("file.navigateBack"); await wait(value => value.label === "Edit symbol-source.ts");
    await goTo(3, 3); await command("file.goToDefinition");
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "second");
    if (await hasCommand("file.navigateForward")) throw new Error("New navigation retained a forward branch");
    checks.push("Forward revisits a location; a new symbol lookup branches history.");
    await command("file.navigateBack"); await wait(value => value.label === "Edit symbol-source.ts");
    await goTo(6, 12); await command("file.goToDefinition");
    await wait(value => value.choices === 2); await capture("02-multiple-definitions");
    await click("Open symbol-source.ts, line 5, column 11");
    await wait(value => value.selection.text === "Merged"); checks.push("Real merged TypeScript declarations produce actionable multiple-definition choices.");
    await goTo(7, 29); await command("file.goToDefinition");
    await wait(value => value.messages.some(message => message?.includes("No semantic definition"))); await capture("03-no-definition");
    checks.push("A comment word is not substituted for a semantic symbol.");
    await goTo(3, 3); await capture("04-away-caret-before-click");
    const token = await page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].find(node => node.getClientRects().length);
      const root = frame?.querySelector("diffs-container")?.shadowRoot;
      const token = [...(root?.querySelectorAll<HTMLElement>('[data-line="2"] [data-char]') ?? [])].find(node => node.textContent === "first");
      if (!token) throw new Error("The native Pierre token interaction target is missing.");
      const rect = token.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try { await page.mouse.click(token.x, token.y); } finally { await page.keyboard.up(modifier); }
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    await capture("05-native-token-click"); checks.push("Pierre's real token modifier-click uses semantic definitions, not a text search.");
    await command("file.navigateBack");
    await wait(value => value.label === "Edit symbol-source.ts" && value.selection.anchor?.line === 2 && value.selection.anchor.column === 1
      && value.selection.focus?.line === 2 && value.selection.focus.column === 1);
    await capture("06-away-caret-origin");
    checks.push("Modifier-click away from the old caret records the clicked token as Back's origin, not the stale caret.");
    await command("file.navigateForward"); await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    const targetBeforeEdit = await snapshot();
    await waitForEditorFocus("Edit symbol-target.ts");
    await page.keyboard.type("firstChanged");
    await wait(value => Boolean(value.text?.includes("firstChanged")));
    await command("file.navigateBack"); await wait(value => value.label === "Edit symbol-source.ts");
    await command("file.navigateForward"); await wait(value => value.label === "Edit symbol-target.ts" && Boolean(value.text?.includes("firstChanged")));
    await waitForEditorFocus("Edit symbol-target.ts");
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("z"); } finally { await page.keyboard.up(modifier); }
    await wait(value => value.label === "Edit symbol-target.ts" && value.text === targetBeforeEdit.text, "native Undo in the focused target editor");
    await capture("07-unsaved-buffer-native-undo"); checks.push("Back/forward retain the unsaved target and Pierre's original undo timeline; native Undo restores the exact pre-edit text.");
    const pointer = await page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].find(node => node.getClientRects().length);
      const token = [...(frame?.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[data-line="1"] [data-char]') ?? [])].find(node => node.textContent === "first");
      if (!token) throw new Error("The retained editor's native pointer target is missing.");
      const rect = token.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(pointer.x, pointer.y);
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "" && value.selection.anchor?.line === 1 && value.selection.anchor.column >= 17 && value.selection.anchor.column <= 22, "native pointer caret");
    await page.keyboard.down("Shift");
    try { await page.keyboard.press("ArrowRight"); } finally { await page.keyboard.up("Shift"); }
    const shifted = await wait(value => value.selection.text?.length === 1, "Shift/ArrowRight selection");
    await retainSelection(shifted.selection.text!, "Shift/ArrowRight selection");
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("a"); } finally { await page.keyboard.up(modifier); }
    await wait(value => value.selection.text === value.text, "native Select All");
    await retainSelection(targetBeforeEdit.text!, "Native Select All");
    await page.keyboard.press("ArrowRight");
    await wait(value => value.selection.text === "");
    await capture("08-native-selection-input");
    checks.push("Native pointer, Shift/Arrow and Select All/Arrow replace the managed selection after navigation.");
    if (errors.length) throw new Error(errors.join("\n"));
    const result = { passed: true, checks, errors, scope: "Actual App page, production WorkspacePanel/Pierre, existing GoToLine and native Chromium pointer/keyboard input. Requires Main's authenticated disposable host setup. No provider/session or physical-pixel parity claim." };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    await capture("failure").catch(() => {});
    await writeFile(join(output, "result.json"), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)); throw error;
  } finally { page.off("pageerror", onError); await session.detach(); }
}
