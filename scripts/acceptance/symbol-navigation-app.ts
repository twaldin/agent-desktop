import type { applyViewport } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { symbolOffset, type SymbolSelection } from "../../packages/shared/src/symbol-navigation";
import type { SymbolEditorSnapshot } from "../../apps/desktop/src/renderer/symbol-navigation";

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
export async function exerciseSymbolNavigationApp(page: SymbolAcceptancePage, output: string) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await readdir(output)).length) throw new Error("Acceptance output must be a new empty directory; frozen evidence is never overwritten.");
  const checks: string[] = [], errors: string[] = [];
  const onError = (error: unknown) => errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  page.on("pageerror", onError);
  const session = await page.createCDPSession();
  const snapshot = async (): Promise<SymbolAppSnapshot> => {
    // Pierre renders selection overlays; its focused DOM caret intentionally
    // collapses. Read the existing capture callback (Editor.getState), without
    // adding an App hook or changing editor state. CDP uses the main world,
    // unlike the harness's isolated DOM-evaluation world.
    const response = await session.send("Runtime.evaluate", { returnByValue: true, expression: "(" + (() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].find(element => element.getClientRects().length > 0);
      const root = frame?.querySelector("diffs-container")?.shadowRoot;
      const input = root?.querySelector<HTMLElement>('[contenteditable="true"]');
      type Fiber = { memoizedProps?: { capture?: () => SymbolEditorSnapshot | undefined }; child?: Fiber; sibling?: Fiber };
      const key = frame && Object.keys(frame).find(key => key.startsWith("__reactFiber"));
      const fiber = key && (frame as unknown as Record<string, Fiber>)[key];
      const stack = fiber ? [fiber] : [];
      let native: SymbolEditorSnapshot | undefined;
      while (stack.length) {
        const node = stack.pop()!;
        if (node.memoizedProps?.capture) { native = node.memoizedProps.capture(); break; }
        if (node.child) stack.push(node.child);
        if (node !== fiber && node.sibling) stack.push(node.sibling);
      }
      return { label: input?.getAttribute("aria-label"), native,
        domSelection: (root as ShadowRoot & { getSelection?: () => Selection } | undefined)?.getSelection?.()?.toString(),
        messages: [...(frame?.querySelectorAll('[role="status"]') ?? [])].map(node => node.textContent),
        buttons: [...(frame?.querySelectorAll<HTMLButtonElement>(".symbol-navigation button") ?? [])].map(button => ({ text: button.textContent, disabled: button.disabled })),
        choices: frame?.querySelectorAll(".symbol-definition-choices button[aria-label]").length ?? 0 };
    }).toString() + ")()" });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    const { native, ...state } = response.result.value as Omit<SymbolAppSnapshot, "text" | "selection" | "selections"> & { native?: SymbolEditorSnapshot };
    const selection = native?.selections.at(-1);
    return { ...state, text: native?.text, selections: native?.selections ?? [], selection: {
      text: native && selection ? native.text.slice(symbolOffset(native.text, selection.start), symbolOffset(native.text, selection.end)) : undefined,
      anchor: selection ? selection.direction === "backward" ? selection.end : selection.start : null,
      focus: selection ? selection.direction === "backward" ? selection.start : selection.end : null,
    } };
  };
  const wait = async (predicate: (state: SymbolAppSnapshot) => boolean) => {
    for (let attempt = 0; attempt < 500; attempt++) { const value = await snapshot(); if (predicate(value)) return value; await Bun.sleep(50); }
    throw new Error("The actual App did not reach the expected symbol state: " + JSON.stringify(await snapshot()));
  };
  const click = async (label: string) => {
    const point = await page.evaluate((label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".symbol-navigation button")].find(node => node.getClientRects().length && !node.disabled && (node.textContent?.trim() === label || node.getAttribute("aria-label") === label));
      if (!button) throw new Error("No enabled symbol action: " + label);
      const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, label);
    await page.mouse.click(point.x, point.y);
  };
  const goTo = async (line: number, column: number) => {
    await page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].find(node => node.getClientRects().length);
      frame?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
    });
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("l"); } finally { await page.keyboard.up(modifier); }
    const input = await page.waitForSelector('input[aria-label="Go to line"]', { visible: true });
    if (!input) throw new Error("Production GoToLine did not open");
    await input.type(String(line)); await page.keyboard.press("Enter");
    for (let offset = 1; offset < column; offset++) await page.keyboard.press("ArrowRight");
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: join(output, name + ".png") });
    await writeFile(join(output, name + ".json"), JSON.stringify(await snapshot(), null, 2));
  };
  try {
    await wait(value => value.label === "Edit symbol-source.ts");
    await goTo(2, 3); const origin = await snapshot();
    if (!origin.selection.anchor || !origin.selection.focus) throw new Error("The real native cursor could not be observed.");
    await click("Go to definition");
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    await capture("01-definition"); checks.push("Real compiler request opens imported declaration in the actual App/Pierre editor.");
    await click("Back to symbol");
    await wait(value => value.label === "Edit symbol-source.ts" && !value.buttons.find(button => button.text === "Forward to symbol")?.disabled && JSON.stringify(value.selection) === JSON.stringify(origin.selection));
    checks.push("Back restores the exact original native cursor and selection.");
    await click("Forward to symbol"); await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    await click("Back to symbol"); await wait(value => value.label === "Edit symbol-source.ts");
    await goTo(3, 3); await click("Go to definition");
    await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "second");
    if (!(await snapshot()).buttons.find(button => button.text === "Forward to symbol")?.disabled) throw new Error("New navigation retained a forward branch");
    checks.push("Forward revisits a location; a new symbol lookup branches history.");
    await click("Back to symbol"); await wait(value => value.label === "Edit symbol-source.ts");
    await goTo(6, 12); await click("Go to definition");
    await wait(value => value.choices === 2); await capture("02-multiple-definitions");
    await click("Open symbol-source.ts, line 5, column 11");
    await wait(value => value.selection.text === "Merged"); checks.push("Real merged TypeScript declarations produce actionable multiple-definition choices.");
    await goTo(7, 29); await click("Go to definition");
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
    await click("Back to symbol");
    await wait(value => value.label === "Edit symbol-source.ts" && value.selection.anchor?.line === 2 && value.selection.anchor.column === 1
      && value.selection.focus?.line === 2 && value.selection.focus.column === 1);
    await capture("06-away-caret-origin");
    checks.push("Modifier-click away from the old caret records the clicked token as Back's origin, not the stale caret.");
    await click("Forward to symbol"); await wait(value => value.label === "Edit symbol-target.ts" && value.selection.text === "first");
    const targetBeforeEdit = await snapshot();
    await page.keyboard.type("firstChanged");
    await wait(value => Boolean(value.text?.includes("firstChanged")));
    await click("Back to symbol"); await wait(value => value.label === "Edit symbol-source.ts");
    await click("Forward to symbol"); await wait(value => value.label === "Edit symbol-target.ts" && Boolean(value.text?.includes("firstChanged")));
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("z"); } finally { await page.keyboard.up(modifier); }
    await wait(value => value.label === "Edit symbol-target.ts" && value.text === targetBeforeEdit.text);
    await capture("07-unsaved-buffer-native-undo"); checks.push("Back/forward retain the unsaved target and Pierre's original undo timeline; native Undo restores the exact pre-edit text.");
    if (errors.length) throw new Error(errors.join("\n"));
    const result = { passed: true, checks, errors, scope: "Actual App page, production WorkspacePanel/Pierre, existing GoToLine and native Chromium pointer/keyboard input. Requires Main's authenticated disposable host setup. No provider/session or physical-pixel parity claim." };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    await capture("failure").catch(() => {});
    await writeFile(join(output, "result.json"), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)); throw error;
  } finally { page.off("pageerror", onError); await session.detach(); }
}
