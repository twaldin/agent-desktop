import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";
import type { SessionSubagentRow, SessionSubagentTarget } from "../../../../packages/shared/src/session-subagents";
import { SubagentsPanelContent } from "./SubagentsPanel";
import { initialSessionSubagentsView, type SessionSubagentDetail, type SessionSubagentsList, type SessionSubagentsView } from "./session-subagents-state";
import type { AttachmentMediaContext } from "./attachment-media";

const owner = { nativeSessionId: "native-a", epoch: "epoch-1" };
const NOW = 1_800_000_000_000;
const hour = 3_600_000;
const target = (id: string): SessionSubagentTarget => ({ id, sessionId: `child-${id}`, guard: `g-${id}` });
const rows: SessionSubagentRow[] = [
  { target: target("w1"), displayName: "Ui reference fixture", status: "running", running: true, createdAt: NOW - 3 * 60_000, lastActivity: NOW - 4_000, activity: "building OOXML package" },
  { target: target("w2"), displayName: "Evidence audit", status: "idle", running: false, createdAt: NOW - 30 * hour, lastActivity: NOW - 22 * hour },
  { target: target("w3"), displayName: "Deckbox evidence", status: "parked", running: false, createdAt: NOW - 30 * hour, lastActivity: NOW - 23 * hour },
  { target: target("w4"), displayName: "Lindy evidence", status: "aborted", running: false, createdAt: NOW - 3 * 86_400_000, lastActivity: NOW - 2 * 86_400_000 },
];
const list = (patch: Partial<SessionSubagentsList> = {}): SessionSubagentsList => ({ action: "list", owner, availability: "available", rows, omitted: 0, ...patch });
const view = (patch: Partial<SessionSubagentsView> = {}): SessionSubagentsView => ({ ...initialSessionSubagentsView("host-1", "session-1", true, true, true), loading: false, list: list(), ...patch });
const message = (id: string, text: string, model?: string): TranscriptMessage => ({ id, nativeId: `n-${id}`, role: "assistant", text, lifecycle: "complete", content: [{ type: "text", text }], ...(model ? { assistant: { provider: "anthropic", model } } : {}) });
const detail = (patch: Partial<SessionSubagentDetail> = {}): SessionSubagentDetail => ({
  owner, target: rows[1]!.target, row: rows[1]!, state: "ready", stale: false, live: false,
  transcript: { action: "transcript", owner, target: rows[1]!.target, availability: "available", messages: [message("m1", "PASS. No material corrections.", "claude-fable")], cwd: "/work/child", truncated: false },
  ...patch,
});
const controls = { refresh: async () => {}, reload: async () => {}, open: async () => {}, back() {}, openFile: async () => {}, closePreview() {}, openExternal: async () => {}, image: async () => { throw new Error("unused"); } };
const media: AttachmentMediaContext = { bridge: {}, cache: { put: async () => {}, get: async () => null, close() {} } };
const render = (state: SessionSubagentsView) => renderToStaticMarkup(<SubagentsPanelContent view={state} state={controls} media={media} now={NOW}/>);
const attribute = (html: string, name: string) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map(match => match[1]);
const rowButtons = (html: string) => [...html.matchAll(/<button[^>]*data-subagent-id="([^"]+)"[^>]*>(.*?)<\/button>/g)].map(match => ({ id: match[1]!, tag: match[0], body: match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));

test("the roster splits Active from Done, keeps each row's native status instead of a completion claim, and trails the pinned relative age", () => {
  const html = render(view());
  expect(html).toContain("Active · 1");
  expect(html).toContain("Done · 3");
  const buttons = rowButtons(html);
  expect(buttons.map(button => button.id)).toEqual(["w1", "w2", "w3", "w4"]);
  expect(buttons[0]).toMatchObject({ body: "U Ui reference fixture building OOXML package 4s" });
  expect(buttons[0]!.tag).toContain('data-subagent-status="running"');
  expect(buttons[1]!.body).toBe("E Evidence audit Idle 22h ago");
  expect(buttons[2]!.body).toBe("D Deckbox evidence Parked 23h ago");
  expect(buttons[3]!.body).toBe("L Lindy evidence Aborted 2d ago");
  expect(html).not.toContain("Completed");
  expect(html).not.toMatch(/<textarea|Stop all|Resume|Send/);
  expect(attribute(html, "data-group")).toEqual(["active", "done"]);
});

test("an empty Active group shows the pinned placeholder and truncation is reported rather than silently dropped", () => {
  const html = render(view({ list: list({ rows: rows.slice(1), omitted: 2 }) }));
  expect(html).toContain("Active · 0");
  expect(html).toContain("No active subagents");
  expect(html).toContain("2 more subagents are not listed");
  const empty = render(view({ list: list({ rows: [] }) }));
  expect(empty).toContain("No active subagents");
  expect(empty).toContain("No finished or parked subagents");
});

test("unsupported, offline, loading, failed, owner-replaced, unavailable and stale-offline states are each distinct", () => {
  expect(attribute(render(view({ supported: false, list: undefined })), "data-kind")).toEqual(["unsupported"]);
  expect(attribute(render(view({ connected: false, list: undefined })), "data-kind")).toEqual(["offline"]);
  expect(attribute(render(view({ loading: true, list: undefined })), "data-kind")).toEqual(["loading"]);
  expect(attribute(render(view({ error: "host unreachable", list: undefined })), "data-kind")).toEqual(["error"]);
  const replaced = render(view({ stale: true, ownerChanged: true, error: "changed" }));
  expect(attribute(replaced, "data-kind")).toEqual(["owner-changed"]);
  expect(replaced).toContain("Read current native session");
  expect(replaced).toContain("nothing retargets automatically");
  expect(rowButtons(replaced)).toHaveLength(4);
  const failed = render(view({ stale: true, error: "host unreachable" }));
  expect(attribute(failed, "data-kind")).toEqual(["error", "stale"]);
  expect(failed).toContain("Retry read");
  const offline = render(view({ connected: false, stale: true }));
  expect(attribute(offline, "data-kind")).toEqual(["stale"]);
  expect(offline).toContain("while this host is offline");
  expect(rowButtons(offline).every(button => button.tag.includes("disabled"))).toBe(true);
  expect(attribute(render(view({ list: list({ availability: "unavailable", rows: [], reason: "Registry not attached" }) })), "data-kind")).toEqual(["unavailable"]);
});

test("the child detail offers only Back and the read-only conversation, and reports the actual recorded model", () => {
  const html = render(view({ detail: detail() }));
  expect(html).toContain('data-view="detail"');
  expect(html).toContain('aria-label="Back to subagents"');
  expect(html).toContain("Evidence audit");
  expect(html).toContain(">Idle<");
  expect(html).toContain("Uses anthropic/claude-fable");
  expect(html).toContain("PASS. No material corrections.");
  expect(html).not.toMatch(/<textarea|Stop|Resume|Send|Edit message|Fork/);
  expect(rowButtons(html)).toHaveLength(0);
  expect(html).not.toContain("Working…");
});

test("missing, unavailable, truncated, orphaned and stale child logs surface as the host reported them", () => {
  const base = detail();
  const missing = render(view({ detail: detail({ transcript: { ...base.transcript!, availability: "missing", messages: [], reason: "No journal for child-w2" } }) }));
  expect(attribute(missing, "data-kind")).toEqual(["missing"]);
  expect(missing).toContain("No journal for child-w2");
  const unavailable = render(view({ detail: detail({ transcript: { ...base.transcript!, availability: "unavailable", messages: [], reason: "Registry detached" } }) }));
  expect(attribute(unavailable, "data-kind")).toEqual(["unavailable"]);
  const truncated = render(view({ detail: detail({ transcript: { ...base.transcript!, truncated: true } }) }));
  expect(attribute(truncated, "data-kind")).toEqual(["truncated"]);
  expect(truncated).toContain("PASS. No material corrections.");
  const orphan = render(view({ list: list({ rows: rows.filter(row => row.target.id !== "w2") }), detail: detail() }));
  expect(attribute(orphan, "data-kind")).toEqual(["orphan"]);
  expect(orphan).toContain("Evidence audit");
  const stale = render(view({ connected: false, stale: true, detail: detail({ stale: true }) }));
  expect(attribute(stale, "data-kind")).toEqual(["stale"]);
  expect(stale).toContain("while this host is offline");
  const failed = render(view({ detail: detail({ state: "failed", transcript: undefined, error: "journal unreadable" }) }));
  expect(attribute(failed, "data-kind")).toEqual(["error"]);
  expect(failed).toContain("journal unreadable");
  const pending = render(view({ detail: detail({ state: "pending", transcript: undefined }) }));
  expect(attribute(pending, "data-kind")).toEqual(["loading"]);
  expect(attribute(render(view({ detail: detail({ transcript: { ...base.transcript!, messages: [] } }) })), "data-kind")).toEqual(["empty"]);
});


test("a file preview nests inside the child detail as read-only text with its own back control", () => {
  const html = render(view({ detail: detail({ preview: { path: "src/index.ts", state: "ready", text: "export const child = 1;", truncated: true } }) }));
  expect(html).toContain('aria-label="Back to subagent conversation"');
  expect(html).toContain('aria-label="Back to subagents"');
  expect(html).toContain("Read-only");
  expect(html).toContain("src/index.ts");
  expect(html).toContain("export const child = 1;");
  expect(attribute(html, "data-kind")).toEqual(["truncated"]);
  expect(html).not.toContain("PASS. No material corrections.");
  const failed = render(view({ detail: detail({ preview: { path: "src/index.ts", state: "failed", error: "outside the subagent's working directory" } }) }));
  expect(attribute(failed, "data-kind")).toEqual(["error"]);
  expect(failed).toContain("outside the subagent");
});
