import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionProcessesSnapshot, SessionProcessRow, SessionProcessState, SessionProcessTarget } from "../../../../packages/shared/src/session-processes";
import { captureProcessMutation, processInputIssue, resolveInputDraft, SessionProcessesPanel, SessionProcessesPanelContent } from "./SessionProcessesPanel";
import type { SessionProcessesView, SessionProcessOperationView } from "./session-processes-state";

type Props = { children?: unknown; disabled?: boolean; title?: string; "aria-label"?: string; role?: string; className?: string;
  "data-operation-status"?: string; "data-operation-generation"?: number; "data-process-state"?: string; "data-kind"?: string; onClick?: () => void };
type Controls = Parameters<typeof SessionProcessesPanelContent>[0]["state"];

function nodes(input: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(input)) return input.flatMap(nodes);
  if (!React.isValidElement<Props>(input)) return [];
  return [input, ...nodes(input.props.children)];
}
function text(input: unknown): string {
  if (Array.isArray(input)) return input.map(text).join("");
  if (React.isValidElement<Props>(input)) return text(input.props.children);
  return typeof input === "string" || typeof input === "number" ? String(input) : "";
}
function button(tree: unknown, label: string) {
  const node = nodes(tree).find(node => node.type === "button" && (node.props["aria-label"] === label || text(node) === label));
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
function tag(html: string, label: string) {
  const match = html.match(new RegExp(`<[a-z]+[^>]*aria-label="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`));
  if (!match) throw new Error(`Missing element ${label}`);
  return match[0];
}

const owner = { nativeSessionId: "session", epoch: "epoch-1", projectDir: "/tmp/project" };
function target(name: string, generation = 1, id = `${name}-record`): SessionProcessTarget {
  return { brokerId: "broker-1", name, id, generation };
}
function row(state: SessionProcessState, name: string, patch: Partial<SessionProcessRow> = {}): SessionProcessRow {
  return { target: target(name), state, createdAt: 1_700_000_000_000, startedAt: 1_700_000_001_000, restartCount: 0, outputBytes: 0,
    readyPending: [], persist: false, detached: false, ...patch };
}
function snapshot(...rows: SessionProcessRow[]): SessionProcessesSnapshot {
  return { owner, brokerId: "broker-1", rows };
}
function view(patch: Partial<SessionProcessesView> = {}): SessionProcessesView {
  return { hostId: "home", sessionId: "session", supported: true, connected: true, visible: true, loading: false, reading: false,
    stale: false, busy: false, operations: [], journalState: "ready", ...patch };
}
function operation(patch: Partial<SessionProcessOperationView> = {}): SessionProcessOperationView {
  return { operationId: "op-1", owner, target: target("web"), action: "stop", status: "pending", lookupPending: false, ...patch };
}
function controls() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); return Promise.resolve(); };
  const state = { refresh: record("refresh"), inspect: record("inspect"), closeLogs: record("closeLogs"), mutate: record("mutate"),
    lookupReceipt: record("lookupReceipt"), retryJournal: record("retryJournal"), dismissOperation: record("dismissOperation") } as unknown as Controls;
  return { calls, state };
}

test("every broker state is listed with the readiness, pid, exit and supervision facts the row actually carries", () => {
  const rows = [
    row("ready", "web", { pid: 4242, readyAt: 1_700_000_002_000, persist: true }),
    row("running", "worker", { pid: 4243, outputBytes: 2048 }),
    row("starting", "db", { readyPending: ["log", "port"] }),
    row("restarting", "cache", { restartCount: 3 }),
    row("stopping", "proxy", { pid: 4244 }),
    row("failed", "sidecar", { exitedAt: 1_700_000_003_000, exitCode: 1 }),
    row("exited", "once", { exitedAt: 1_700_000_004_000, detached: true }),
  ];
  const tree = SessionProcessesPanelContent({ view: view({ snapshot: snapshot(...rows) }), state: controls().state });
  const listed = nodes(tree).filter(node => node.type === "li");
  expect(listed.map(node => node.props["data-process-state"])).toEqual(["ready", "running", "starting", "restarting", "stopping", "failed", "exited"]);
  const starting = listed[2]!;
  expect(text(starting)).toContain("the broker has not observed a matching log line and an accepting port yet");
  expect(text(starting)).toContain("no pid reported");
  expect(text(starting)).not.toContain("Ready");
  expect(text(listed[0]!)).toContain("pid 4242");
  expect(text(listed[3]!)).toContain("3 restarts");
  expect(text(listed[5]!)).toContain("exit code 1");
  expect(text(listed[6]!)).toContain("The broker reported no exit code for this process.");
  // Readiness, pid and exit facts are shown only where the row carries them.
  expect(text(listed[1]!)).not.toContain("Readiness pending");
  expect(text(listed[1]!)).not.toContain("exit code");
});

test("offline cached processes and output stay readable while every side effect is refused", () => {
  const cached = row("running", "web", { pid: 7 });
  const { calls, state } = controls();
  const offline = view({ connected: false, stale: true, snapshot: snapshot(cached),
    logs: { target: target("web"), state: "ready", text: "cached line", truncated: false } });
  const tree = SessionProcessesPanelContent({ view: offline, state });
  expect(button(tree, "Refresh OMP project processes").props.disabled).toBe(true);
  for (const label of ["Stop web", "Restart web"]) expect(button(tree, label).props.disabled).toBe(true);
  expect(text(tree)).toContain("cached line");
  expect(text(tree)).toContain("Stop, Restart and standard input stay disabled");
  // Closing cached output is local, so it stays available while the host is unreachable.
  button(tree, "Close recent output of web").props.onClick!();
  expect(calls.map(call => call.method)).toEqual(["closeLogs"]);
  const html = renderToStaticMarkup(<SessionProcessesPanelContent view={offline} state={state}/>);
  expect(tag(html, "Send standard input to web")).toContain("disabled");
  expect(html).toContain('data-connected="false"');
});

test("an unsettled operation offers only a receipt lookup and blocks further operations on the same process name", () => {
  const restarted = row("running", "web", { target: target("web", 2), pid: 9, restartCount: 1 });
  const { calls, state } = controls();
  const tree = SessionProcessesPanelContent({
    view: view({ snapshot: snapshot(restarted, row("running", "worker")),
      operations: [operation({ operationId: "op-unknown", action: "input", status: "unknown", target: target("web", 1) })] }),
    state,
  });
  const note = nodes(tree).find(node => node.props["data-operation-status"] === "unknown")!;
  expect(note.props.role).toBe("alert");
  expect(nodes(note).filter(node => node.type === "button").map(node => text(node))).toEqual(["Check status"]);
  for (const label of ["Stop web", "Restart web"]) {
    expect(button(tree, label).props.disabled).toBe(true);
  }
  // The note carries the operation's own generation, never the listed row's.
  expect(note.props["data-operation-generation"]).toBe(1);
  button(note, "Check status").props.onClick!();
  expect(calls).toEqual([{ method: "lookupReceipt", args: ["op-unknown"] }]);
});

test("only durable terminal operations can be dismissed, and a completed restart reports the generation the host confirmed", () => {
  const confirmed = row("running", "web", { target: target("web", 2), restartCount: 1 });
  const { calls, state } = controls();
  const tree = SessionProcessesPanelContent({
    view: view({ snapshot: snapshot(confirmed), operations: [
      operation({ operationId: "op-done", action: "restart", status: "completed", target: target("web", 1), row: confirmed }),
      operation({ operationId: "op-refused", action: "stop", status: "rejected", target: target("web", 2), error: "The broker refused: process is detached." }),
      operation({ operationId: "op-saving", action: "stop", status: "saving", target: target("web", 2) }),
    ] }),
    state,
  });
  const notes = nodes(tree).filter(node => node.props["data-operation-status"]);
  expect(notes.map(node => node.props["data-operation-status"])).toEqual(["completed", "rejected", "saving"]);
  const details = nodes(notes[0]!).find(node => node.type === "details")!;
  expect(text(details)).toContain("Original generation 1");
  expect(text(details)).toContain("Confirmed generation 2");
  expect(text(notes[1]!)).toContain("The broker refused: process is detached.");
  expect(notes[1]!.props.role).toBe("alert");
  expect(text(notes[2]!)).toContain("Nothing has been sent yet.");
  expect(nodes(notes[2]!).filter(node => node.type === "button")).toHaveLength(0);
  button(notes[0]!, "Dismiss the restart notice for web").props.onClick!();
  button(notes[1]!, "Dismiss the stop notice for web").props.onClick!();
  expect(calls).toEqual([{ method: "dismissOperation", args: ["op-done"] }, { method: "dismissOperation", args: ["op-refused"] }]);
});

test("an operation whose process disappeared stays visible and answerable outside the list", () => {
  const { calls, state } = controls();
  const tree = SessionProcessesPanelContent({
    view: view({ snapshot: snapshot(row("running", "worker")), operations: [operation({ operationId: "op-gone", status: "pending", target: target("web", 4) })] }),
    state,
  });
  const orphans = nodes(tree).find(node => node.type === "section")!;
  expect(orphans.props["aria-label"]).toBe("Operations and output without a listed process");
  button(orphans, "Check status").props.onClick!();
  expect(calls).toEqual([{ method: "lookupReceipt", args: ["op-gone"] }]);
});

test("a control captures its exact target before the state call, so a later list update cannot rebind it", () => {
  const live = row("running", "web", { pid: 11 });
  const { calls, state } = controls();
  const tree = SessionProcessesPanelContent({ view: view({ snapshot: snapshot(live) }), state });
  button(tree, "Stop web").props.onClick!();
  live.target.generation = 99;
  live.target.id = "replaced";
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args[0]).toEqual({ brokerId: "broker-1", name: "web", id: "web-record", generation: 1 });
  expect(calls[0]!.args[0]).not.toBe(live.target);
  expect(calls[0]!.args[1]).toBe("stop");
});

test("standard input refuses empty and overlong drafts and is cleared only by its own send's durable receipt", () => {
  expect(processInputIssue("")).toContain("Type the bytes");
  expect(processInputIssue("y\n")).toBeUndefined();
  expect(processInputIssue("x".repeat(8_192))).toBeUndefined();
  expect(processInputIssue("x".repeat(8_193))).toContain("limited to 8192 characters");
  const web = target("web", 1), sent = "status 42";
  const historical = operation({ operationId: "op-old", action: "input", status: "completed", target: web });
  const submission = { text: sent, target: web, known: [historical.operationId] };
  // A receipt that already existed when this send was captured never clears the new draft.
  expect(resolveInputDraft(view({ operations: [historical] }), submission, sent)).toBeUndefined();
  const fresh = operation({ operationId: "op-new", action: "input", status: "completed", target: web });
  expect(resolveInputDraft(view({ operations: [historical, fresh] }), submission, sent)).toEqual({ settled: fresh, clear: true });
  // A draft the user kept editing while the send was in flight survives its own receipt.
  expect(resolveInputDraft(view({ operations: [fresh] }), submission, `${sent} and more`)).toEqual({ settled: fresh, clear: false });
  for (const status of ["saving", "pending", "unknown", "rejected", "not-sent"] as const) {
    expect(resolveInputDraft(view({ operations: [operation({ operationId: "op-new", action: "input", status, target: web })] }), submission, sent)).toBeUndefined();
  }
  expect(resolveInputDraft(view({ operations: [operation({ operationId: "op-new", action: "stop", status: "completed", target: web })] }), submission, sent)).toBeUndefined();
  expect(resolveInputDraft(view({ operations: [operation({ operationId: "op-new", action: "input", status: "completed", target: target("web", 2) })] }), submission, sent)).toBeUndefined();
});


test("output rendering escapes broker bytes and separates pending, empty, truncated and failed reads", () => {
  const live = row("running", "web");
  const { state } = controls();
  const render = (logs: SessionProcessesView["logs"]) =>
    renderToStaticMarkup(<SessionProcessesPanelContent view={view({ snapshot: snapshot(live), logs })} state={state}/>);
  const injected = render({ target: target("web"), state: "ready", text: "<script>alert(1)</script>", truncated: true });
  expect(injected).not.toContain("<script>");
  expect(injected).toContain("&lt;script&gt;");
  expect(injected).toContain("Output is truncated to the broker&#x27;s log limit");
  expect(render({ target: target("web"), state: "ready", text: "", truncated: false })).toContain("The broker retains no output for this process.");
  expect(render({ target: target("web"), state: "pending" })).toContain("Reading recent output of web…");
  expect(tag(render({ target: target("web"), state: "pending" }), "Close recent output of web")).toContain("disabled");
  const failed = render({ target: target("web"), state: "failed", error: "The broker dropped the log request." });
  expect(failed).toContain("The broker dropped the log request.");
  expect(failed).not.toContain("session-processes-output");
});

test("a failed journal offers a retry that dispatches nothing and an unavailable journal still lists processes", () => {
  const live = row("running", "web");
  const { calls, state } = controls();
  const failed = SessionProcessesPanelContent({ view: view({ snapshot: snapshot(live), journalState: "failed", journalError: "The journal file is read-only." }), state });
  expect(text(nodes(failed).find(node => node.props.role === "alert"))).toContain("The journal file is read-only.");
  button(failed, "Retry operation journal").props.onClick!();
  expect(calls).toEqual([{ method: "retryJournal", args: [] }]);
  const unavailable = SessionProcessesPanelContent({ view: view({ snapshot: snapshot(live), journalState: "unavailable" }), state });
  expect(text(unavailable)).toContain("No durable operation journal is available here");
  expect(nodes(unavailable).filter(node => node.type === "li")).toHaveLength(1);
  expect(button(unavailable, "Refresh OMP project processes").props.disabled).toBeFalsy();
});

test("loading, empty and unsupported reads are reported without inventing rows", () => {
  const { state } = controls();
  expect(text(SessionProcessesPanelContent({ view: view({ loading: true }), state }))).toContain("Loading OMP project processes…");
  const empty = SessionProcessesPanelContent({ view: view({ snapshot: snapshot() }), state });
  expect(text(empty)).toContain("No supervised processes in this project.");
  expect(nodes(empty).filter(node => node.type === "li")).toHaveLength(0);
  const unsupported = SessionProcessesPanelContent({ view: view({ supported: false }), state });
  expect(text(unsupported)).toContain("OMP project processes are unavailable through this desktop bridge.");
  expect(button(unsupported, "Refresh OMP project processes").props.disabled).toBe(true);
});

test("identities that differ only in punctuation keep distinct element ids, and an unrepresentable timestamp still renders", () => {
  const { state } = controls();
  const rows = [
    row("running", "a.b", { target: { brokerId: "broker-1", name: "a.b", id: "x.1", generation: 1 } }),
    row("running", "a-b", { target: { brokerId: "broker-1", name: "a-b", id: "x-1", generation: 1 } }),
    row("exited", "late", { startedAt: 9_000_000_000_000_000, exitedAt: 9_000_000_000_000_000, exitCode: 0 }),
  ];
  const html = renderToStaticMarkup(<SessionProcessesPanelContent view={view({ snapshot: snapshot(...rows) })} state={state}/>);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).toContain("timestamp 9000000000000000");
  expect(html).not.toContain('datetime=""');
  expect(html).toContain("exit code 0");
});

test("visibility is part of availability, so a hidden section reads nothing", () => {
  const { calls, state } = controls();
  const hidden = SessionProcessesPanelContent({ view: view({ visible: false, snapshot: snapshot(row("running", "web")) }), state });
  expect(button(hidden, "Refresh OMP project processes").props.disabled).toBe(true);
  expect(button(hidden, "Show recent output of web").props.disabled).toBe(true);
  expect(calls).toHaveLength(0);
});

test("the mounted panel reports a bridge without native processes instead of pretending to read", () => {
  const html = renderToStaticMarkup(<SessionProcessesPanel bridge={{}} hostId="home" sessionId="session" connected visible/>);
  expect(html).toContain("OMP project processes are unavailable through this desktop bridge.");
  expect(html).toContain('data-supported="false"');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).not.toContain("aria-label=\"Stop");
});

test("raw process identities are available only inside a closed details disclosure", () => {
  const process = row("ready", "web", { pid: 4242, nativeOwner: "native-secret-id",
    target: { brokerId: "broker-long-uuid", name: "web", id: "process-record-id", generation: 73 } });
  const tree = SessionProcessesPanelContent({ view: view({ snapshot: { owner, brokerId: process.target.brokerId, rows: [process] } }), state: controls().state });
  const listed = nodes(tree).find(node => node.type === "li")!;
  const disclosure = nodes(listed).find(node => node.type === "details")!;
  expect(disclosure.props).not.toHaveProperty("open", true);
  for (const identity of ["broker-long-uuid", "process-record-id", "native-secret-id", "gen 73"]) {
    expect(text(disclosure)).toContain(identity);
    const visibleChildren = React.Children.toArray(listed.props.children as React.ReactNode)
      .filter(child => React.isValidElement(child) && child.type !== "details");
    expect(text(visibleChildren)).not.toContain(identity);
  }
  expect(text(listed)).toContain("pid 4242");
  expect(button(listed, "Stop web").props.disabled).toBe(false);
  expect(button(listed, "Restart web").props.disabled).toBe(false);
});
