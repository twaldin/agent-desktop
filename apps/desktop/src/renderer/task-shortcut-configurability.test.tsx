import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import type { CommandKeymapState } from "./command-keymap-state";
import { APP_COMMAND_BINDING_OWNERS } from "./app-command-bindings";
import { numberedMainTaskActions, type MainTaskTarget } from "./main-task-targets";

// Evaluate only the actual App support/eligibility expressions, not its hooks or
// runtime. An old App copy can be selected for the paired regression. This is
// expression + server-render proof, not a mounted App or interactive edit test.
const source = readFileSync(process.env.AGENT_DESKTOP_SHORTCUT_SUPPORT_APP_SOURCE ?? new URL("./App.tsx",import.meta.url),"utf8");
// Deliberately bounded to these current one-line seams; fail closed if App is
// reorganized, rather than substituting a reconstructed support/dispatch model.
const supports = [...source.matchAll(/^\s*const supportedShortcutCommands = (.+);$/gm)];
const dispatch = source.split("\n").filter(line => line.includes("numberedMainTaskActions(")).flatMap(line => {
  const match = line.match(/^\s*\.\.\.\((.*)\),\s*$/); return match ? [match[1]!] : [];
});
const settings = source.match(/<KeyboardShortcutsSettings\b[^>]*\bsupportedCommandIds=\{([^}]+)\}/);
if (supports.length !== 1 || dispatch.length !== 1 || !settings) throw new Error("Actual App support/dispatch/settings seam was not found.");
const supportExpression = new Function("APP_COMMAND_BINDING_OWNERS","currentShortcutOptions",`return (${supports[0]![1]});`) as (owners:typeof APP_COMMAND_BINDING_OWNERS,options:{actions:object}) => Set<string>;
const dispatchExpression = new Function("contentOverlayOpen","numberedMainTaskActions","taskTargets","taskDirection","selectMainTask",`return (${dispatch[0]});`) as (overlay:boolean,actions:typeof numberedMainTaskActions,targets:MainTaskTarget[],direction:"ltr",select:() => void) => Record<string,() => void>;
const ready = {loaded:true,available:true,connected:true,numberTargetAvailable:true} as CommandKeymapState;
function row(markup:string,id:string): string {
  const match = markup.match(new RegExp(`<article[^>]*data-command-id="${id}"[^>]*>([\\s\\S]*?)</article>`));
  if (!match) throw new Error(`Missing rendered row ${id}`);
  return match[1]!;
}

test("actual App keeps all nine installed task shortcuts editable when Settings or plugins suppress their dispatch", () => {
  expect(settings![1]).toBe("supportedShortcutCommands");
  let selections = 0;
  const targets:MainTaskTarget[] = [{kind:"chat",hostId:"home",sessionId:null}];
  for (const [settingsOpen,pluginDirectoryOpen] of [[true,false],[false,true]] as const) {
    const actions = dispatchExpression(settingsOpen||pluginDirectoryOpen,numberedMainTaskActions,targets,"ltr",() => selections++);
    expect(Object.keys(actions)).toEqual([]);
    const supported = supportExpression(APP_COMMAND_BINDING_OWNERS,{actions});
    const html = renderToStaticMarkup(<KeyboardShortcutsSettings data={ready} supportedCommandIds={supported}/>);
    for (let i=1;i<=9;i++) {
      const content = row(html,`focusTab${i}`);
      const buttons = content.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      expect(buttons.every(button => !/\bdisabled(?:=|\s|>)/.test(button))).toBe(true);
      expect(content).not.toContain("Unavailable until");
      expect(supported.has(`focusTab${i}`)).toBe(true);
    }
    expect(supported.has("archiveThread")).toBe(false);
    expect(row(html,"archiveThread")).toContain("Unavailable until");
  }
  const active = dispatchExpression(false,numberedMainTaskActions,targets,"ltr",() => selections++);
  expect(Object.keys(active)).toEqual(["task-tab-1"]);
  active["task-tab-1"]!(); expect(selections).toBe(1);
});

test("installed shortcut support does not bypass the keymap page's connection/write gate", () => {
  const supported = supportExpression(APP_COMMAND_BINDING_OWNERS,{actions:{}});
  const html = renderToStaticMarkup(<KeyboardShortcutsSettings data={{...ready,available:false} as CommandKeymapState} supportedCommandIds={supported}/>);
  for (let i=1;i<=9;i++) {
    const buttons = row(html,`focusTab${i}`).match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.every(button => /\bdisabled(?:=|\s|>)/.test(button))).toBe(true);
  }
});
