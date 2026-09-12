import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalRequestRecovery } from "./TerminalRequestRecovery";
import { BrowserNewTabPanel } from "./BrowserNewTabPanel";
import type { BrowserNewTabController } from "./browser-new-tab";
import type { TerminalWindowIntent } from "../terminal-window-intent";

const intent: TerminalWindowIntent = { version: 1, hostId: "10000000-0000-4000-8000-000000000001", source: { kind: "dock", destination: "bottom" },
  request: { version: 1, requestId: "20000000-0000-4000-8000-000000000002", controlEpoch: "30000000-0000-4000-8000-000000000003",
    target: { sessionId: "40000000-0000-4000-8000-000000000004" }, cols: 120, rows: 30 } };
test("recovery renders an explicit result check, pending state and detached adoption without Retry", () => {
  for (const detached of [false, true]) {
    const html = renderToStaticMarkup(<TerminalRequestRecovery intent={intent} enabled running={false} checking={false} detached={detached} onCheck={() => { throw new Error("Render cannot inspect"); }}/>);
    expect(html).toContain(detached ? "Check result in Terminal" : "Check result"); expect(html).not.toContain("Retry"); expect(html).toContain(intent.request.requestId);
  }
  const html = renderToStaticMarkup(<TerminalRequestRecovery intent={intent} enabled running checking onCheck={() => { throw new Error("Render cannot inspect"); }}/>);
  expect(html).toContain("Checking terminal"); expect(html).toContain("disabled");
});
test("actual recovery button guard dispatches once only while enabled and idle", () => {
  let checks = 0;
  for (const [enabled, running] of [[false, false], [true, true], [true, false]] as const) {
    const element = TerminalRequestRecovery({ intent, enabled, running, checking: running, onCheck() { checks++; } });
    const button = element.props.children.find((child: any) => child?.type === "button");
    expect(button.props.type).toBe("button"); button.props.onClick({ currentTarget: {} });
    expect(checks).toBe(enabled && !running ? 1 : 0);
  }
});
test("restored terminal recovery makes actual browser address readonly without submitting either backend", () => {
  let calls = 0;
  const controller = { tab: { hostId: intent.hostId, target: `session:${intent.request.target && "sessionId" in intent.request.target ? intent.request.target.sessionId : ""}` },
    state: { status: "idle", draft: "kept address" }, connected: true, observePresentation() {}, submit() { calls++; }, edit() { calls++; } } as unknown as BrowserNewTabController;
  const html = renderToStaticMarkup(<BrowserNewTabPanel controller={controller} active terminalRecovery={<TerminalRequestRecovery intent={intent} enabled running={false} checking={false} onCheck={() => { calls++; }}/>}/>);
  expect(html).toContain("kept address"); expect(html).toContain("readOnly"); expect(html).toContain("Check result"); expect(calls).toBe(0);
});
test("App passes original browser origin and retained save observer into the actual acquisition path", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), hook = readFileSync(new URL("./use-workbench-dock.tsx", import.meta.url), "utf8");
  expect(app).toContain("terminalCreations: terminalRequests.intents"); expect(app).toContain("terminalRequests.commit({ hostId");
  expect(app).toContain("terminalRequests.committed(value)"); expect(app).toContain("terminalRequests.saved(value)"); expect(app).toContain("terminalRequests.failed(message)");
  expect(app).toContain("origin.state.draft"); expect(app).toContain("terminalRequests.inspectToDock(requestKey)"); expect(app).toContain("browserMenu.adopt(origin, result.tab, focus, guard)");
  expect(hook).toContain('terminalOwner.prepare(options, signal, create ? "validate" : "reuse", settled)'); expect(hook).not.toContain("client.nativeTerminalAction");
});
