import { expect, test } from "bun:test";
import { browserWorkspaceChoices, matchBrowserWorkspaceChoices, type BrowserWorkspaceAction, type BrowserWorkspaceTab } from "./browser-workspace-suggestions";

const source = { id: "launcher", instanceId: "launcher-instance", destination: "right" as const, title: "New tab" };
const tab = (id: string, title: string, destination: "right" | "bottom" = "right"): BrowserWorkspaceTab => ({ id, title, destination, instanceId: `${id}-instance` });
const actions: BrowserWorkspaceAction[] = [{ id: "review", title: "Review", singletonTabId: "review-tab" },
  { id: "terminal", title: "Terminal" }, { id: "browser", title: "Browser" }, { id: "files", title: "Files", singletonTabId: "files-tab" }];

test("workspace inventory retains actual target/action objects and orders right before Bottom", () => {
  const bottom = { ...tab("terminal-tab", "Terminal", "bottom"), terminalId: "native-owner-terminal" };
  const right = { ...tab("review-tab", "Review"), hostId: "other-owner" };
  const original = [bottom, source, right];
  const choices = browserWorkspaceChoices("Current task", original, actions, source);
  expect(choices.map(choice => [choice.kind, choice.title])).toEqual([
    ["chat", "Current task"], ["tab", "Review"], ["tab", "Terminal"], ["action", "Terminal"], ["action", "Browser"], ["action", "Files"],
  ]);
  const selectedTab = choices.find(choice => choice.kind === "tab" && choice.title === "Terminal");
  expect(selectedTab?.kind === "tab" && selectedTab.tab).toBe(bottom);
  const selectedAction = choices.find(choice => choice.kind === "action" && choice.title === "Browser");
  expect(selectedAction?.kind === "action" && selectedAction.action).toBe(actions[2]);
  expect(original).toEqual([bottom, source, right]);
});

test("source exclusion is region-qualified, labels are not choices, and singleton suppression spans both regions", () => {
  const tabs = [source, { ...tab("label", "Section"), label: true }, tab("launcher", "Other region", "bottom"), tab("files-tab", "File browser", "bottom")];
  const choices = browserWorkspaceChoices("Chat", tabs, actions, source);
  expect(choices.filter(choice => choice.kind === "tab").map(choice => choice.title)).toEqual(["Other region", "File browser"]);
  expect(choices.filter(choice => choice.kind === "action").map(choice => choice.title)).toEqual(["Review", "Terminal", "Browser"]);
  const labelSingleton = browserWorkspaceChoices("Chat", [{ ...tab("review-tab", "Label"), label: true }], actions, source);
  expect(labelSingleton.some(choice => choice.kind === "action" && choice.action.id === "review")).toBe(false);
});

test("choice identity includes the destination and actual presentation incarnation, without delimiter collisions", () => {
  const choices = browserWorkspaceChoices("Chat", [tab("x", "A"), { ...tab("x", "B", "bottom"), instanceId: "new" },
    { ...tab("x", "C"), instanceId: "another" }, tab("a:b", "D"), { ...tab("b", "E"), instanceId: "a:b" }], [], source);
  expect(new Set(choices.map(choice => choice.id)).size).toBe(choices.length);
  expect(choices.filter(choice => choice.kind === "tab").map(choice => JSON.parse(choice.id))).toEqual([
    ["tab", "right", "x-instance", "x"], ["tab", "right", "another", "x"], ["tab", "right", "a:b-instance", "a:b"],
    ["tab", "right", "a:b", "b"], ["tab", "bottom", "new", "x"],
  ]);
});

test("an empty query shows launch actions only and never defaults a choice", () => {
  const choices = browserWorkspaceChoices("Terminal chat", [source, tab("shell", "Terminal")], actions, source);
  const rows = matchBrowserWorkspaceChoices(choices, "", "en-US", true);
  expect(rows.map(row => row.title)).toEqual(["Review", "Terminal", "Browser", "Files"]);
  expect(rows.every(row => row.kind === "action" && !row.canBeDefault && !row.isExistingDestination && row.textMatch === undefined)).toBe(true);
  expect(matchBrowserWorkspaceChoices(choices, "   ", "en-US", true)).toEqual([]);
});

test("literal scheme and www addresses do not generate workspace completions", () => {
  for (const query of ["https:", "HTTP://", "ssh+git:", "about:blank", "file:", "www.", " WWW.Example "]) {
    const choices = browserWorkspaceChoices(query, [tab("same", query)], [{ id: "same", title: query }], source);
    expect(matchBrowserWorkspaceChoices(choices, query, "en-US", true)).toEqual([]);
  }
});

test("exact then prefix then substring outranks destination preference, with stable order within ties", () => {
  const choices = browserWorkspaceChoices("Review notes", [tab("first", "Review notes"), tab("second", "A review"), tab("third", "Review", "bottom")],
    [{ id: "exact", title: "Review" }, { id: "prefix", title: "Review more" }, { id: "substring", title: "A review action" }], source);
  const rows = matchBrowserWorkspaceChoices(choices, " REVIEW ", "en-US", true);
  expect(rows.map(row => [row.kind, row.title, row.textMatch])).toEqual([
    ["tab", "Review", "exact"], ["action", "Review", "exact"],
    ["chat", "Review notes", "prefix"], ["tab", "Review notes", "prefix"], ["action", "Review more", "prefix"],
    ["tab", "A review", "substring"], ["action", "A review action", "substring"],
  ]);
  expect(rows.every(row => row.canBeDefault)).toBe(true);
  expect(choices[0]?.title).toBe("Review notes");
});

test("query eligibility remains with the address parser instead of being inferred from a matching title", () => {
  const choices = browserWorkspaceChoices("example.com", [], [{ id: "action", title: "example.com" }], source);
  expect(matchBrowserWorkspaceChoices(choices, "example.com", "en-US", false).map(row => row.canBeDefault)).toEqual([false, false]);
  expect(matchBrowserWorkspaceChoices(choices, "example.com", "en-US", true).map(row => row.canBeDefault)).toEqual([true, true]);
});

test("locale-aware matching preserves original display strings and internal whitespace", () => {
  const choices = browserWorkspaceChoices("IŞIK  panel", [tab("other", "ışık  another")], [], source);
  const rows = matchBrowserWorkspaceChoices(choices, " ışık  ", "tr", true);
  expect(rows.map(row => row.title)).toEqual(["IŞIK  panel", "ışık  another"]);
  expect(matchBrowserWorkspaceChoices(choices, "ışık panel", "tr", true)).toEqual([]);
  expect(matchBrowserWorkspaceChoices(choices, "ışık  panel", "tr", true).map(row => row.title)).toEqual(["IŞIK  panel"]);
  expect(matchBrowserWorkspaceChoices(choices, "not found", "tr", true)).toEqual([]);
});
