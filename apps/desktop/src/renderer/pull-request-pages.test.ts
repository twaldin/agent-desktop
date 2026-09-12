import { expect, test } from "bun:test";
import {
  detail,
  inbox,
  summary,
} from "../../../../scripts/acceptance/pull-requests/data";
import {
  appendPullRequestDetail,
  appendPullRequestInbox,
} from "./pull-request-pages";
import {
  PullRequestCache,
  pullRequestSnapshotForView,
} from "./pull-request-cache";
import {
  pullRequestQuery,
  visiblePullRequestSections,
} from "./pull-request-query";

test("pagination extends only requested sections and retains completed pages", () => {
  const first = inbox(),
    next = inbox();
  next.sections = [
    {
      ...next.sections[0]!,
      items: [summary(10)],
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
        totalCount: 2,
        truncated: false,
      },
    },
  ];
  const merged = appendPullRequestInbox(first, next);
  expect(
    merged.sections.map((section) => section.items.map((item) => item.nodeId)),
  ).toEqual([["PR_7", "PR_10"], ["PR_7", "PR_8"], [], ["PR_9"]]);
  expect(merged.sections[0]!.pageInfo.hasNextPage).toBe(false);
  expect(first.sections[0]!.items.map((item) => item.nodeId)).toEqual(["PR_7"]);
  expect(() =>
    appendPullRequestInbox(first, {
      ...next,
      account: { ...next.account, id: "other" },
    }),
  ).toThrow("search changed");
  expect(() =>
    appendPullRequestInbox(first, {
      ...next,
      filters: { ...next.filters, search: "other" },
    }),
  ).toThrow("search changed");
});
test("section priority avoids duplicate rows and preserves direct-request failure fallback", () => {
  const data = inbox();
  expect(
    visiblePullRequestSections(data.sections).map((section) =>
      section.items.map((item) => item.nodeId),
    ),
  ).toEqual([["PR_7"], ["PR_8"], [], ["PR_9"]]);
  data.sections[0]!.error = "Direct review requests unavailable";
  const fallback = visiblePullRequestSections(data.sections);
  expect(fallback[0]!.items.map((item) => item.nodeId)).toEqual([
    "PR_7",
    "PR_8",
  ]);
  expect(fallback[0]!.error).toContain("unavailable");
  expect(fallback[1]!.items).toEqual([]);
});
test("detail page merge preserves other sections and rejects a new head or target", () => {
  const first = detail(),
    next = detail();
  next.discussion.items[0]!.id = "comment2";
  next.body = "This is not a refreshed body";
  const merged = appendPullRequestDetail(first, next, "discussion");
  expect(merged.discussion.items.map((item) => item.id)).toEqual([
    "comment1",
    "comment2",
  ]);
  expect(merged.body).toBe(first.body);
  expect(() =>
    appendPullRequestDetail(first, { ...next, revision: "new" }, "discussion"),
  ).toThrow("changed");
  expect(() =>
    appendPullRequestDetail(
      first,
      { ...next, summary: summary(99) },
      "discussion",
    ),
  ).toThrow("changed");
});
test("later complete thread pages retain an earlier upstream truncation warning", () => {
  const first = detail(),
    next = detail();
  first.discussion.pageInfo.truncated = true;
  next.discussion.items[0]!.id = "next-thread-comment";
  next.discussion.pageInfo = {
    hasNextPage: false,
    endCursor: null,
    totalCount: 2,
    truncated: false,
  };
  const merged = appendPullRequestDetail(first, next, "discussion");
  expect(merged.discussion.items.map((item) => item.id)).toEqual([
    "comment1",
    "next-thread-comment",
  ]);
  expect(merged.discussion.pageInfo).toMatchObject({
    hasNextPage: false,
    truncated: true,
  });
  expect(next.discussion.pageInfo.truncated).toBe(false);
});
test("accumulated detail byte limit fails without replacing the earlier readable page", () => {
  const first = detail(),
    next = detail();
  next.discussion.items = Array.from({ length: 50 }, (_, id) => ({
    ...first.discussion.items[0]!,
    id: String(id),
    body: "x".repeat(256 * 1024),
  }));
  expect(() => appendPullRequestDetail(first, next, "discussion")).toThrow(
    "display limit",
  );
  expect(first.discussion.items).toHaveLength(1);
});
test("query controls honor explicit unquoted qualifiers and retain ordinary quoted prose", () => {
  const filters = {
    ...inbox().filters,
    view: "reviewing" as const,
    lifecycle: "closed" as const,
    repository: { owner: "one", repository: "repo" },
  };
  expect(
    pullRequestQuery(filters, 'fix "author:someone"').filters,
  ).toMatchObject({
    lifecycle: "open",
    repository: filters.repository,
    rawQuery: null,
  });
  const raw = pullRequestQuery(
    filters,
    "author:someone is:merged repo:other/name sort:created",
  );
  expect(raw.explicitLifecycle).toBe(true);
  expect(raw.explicitRelationship).toBe(true);
  expect(raw.filters).toMatchObject({
    lifecycle: "all",
    repository: null,
    rawQuery: "author:someone is:merged repo:other/name sort:created",
  });
  expect(
    pullRequestQuery(filters, 'label:"author:someone"').explicitRelationship,
  ).toBe(false);
  expect(
    pullRequestQuery(filters, "mentions:someone").explicitRelationship,
  ).toBe(true);
});
test("window-local cache survives page closure but expires and evicts bounded host results", () => {
  let now = 0;
  const cache = new PullRequestCache(() => now);
  cache.put("host", { inbox: inbox() });
  expect(cache.get("host")?.inbox?.sections[0]!.items[0]!.title).toContain(
    "original",
  );
  now = 600_001;
  expect(cache.get("host")).toBeUndefined();
  for (let i = 0; i < 9; i++) cache.put(`host${i}`, { detail: detail() });
  expect(cache.get("host0")).toBeUndefined();
  expect(cache.get("host8")?.detail?.revision).toBe("a".repeat(40));
  const oversized = detail();
  oversized.body = "x".repeat(12 * 1024 * 1024);
  cache.put("host8", { detail: oversized });
  expect(cache.get("host8")).toBeUndefined();
});

test("offline cached content follows the restored account, query and original selected PR", () => {
  const data = inbox(),
    selected = detail();
  const snapshot = { inbox: data, detail: selected };
  const view = {
    hostId: "host",
    accountId: data.account.id,
    filters: data.filters,
    selected: selected.summary.pullRequest,
  };
  expect(pullRequestSnapshotForView(snapshot, view)).toEqual(snapshot);
  expect(
    pullRequestSnapshotForView(snapshot, { ...view, accountId: "other" }),
  ).toEqual({ availability: undefined, inbox: undefined, detail: undefined });
  const changed = pullRequestSnapshotForView(snapshot, {
    ...view,
    filters: { ...view.filters, search: "different" },
    selected: summary(99).pullRequest,
  });
  expect(changed.inbox).toBeUndefined();
  expect(changed.detail).toBeUndefined();
});
test("pagination refuses repeated live cursors and preserves the readable pages", () => {
  const first = inbox();
  first.sections[0]!.pageInfo = {
    hasNextPage: true,
    endCursor: "stuck",
    totalCount: 100,
    truncated: false,
  };
  const next = structuredClone(first);
  expect(() => appendPullRequestInbox(first, next)).toThrow(
    "same search cursor",
  );
  expect(first.sections[0]!.items).toHaveLength(1);
  const current = detail();
  current.files.pageInfo = {
    hasNextPage: true,
    endCursor: "stuck",
    totalCount: 100,
    truncated: false,
  };
  expect(() =>
    appendPullRequestDetail(current, structuredClone(current), "files"),
  ).toThrow("same detail cursor");
  expect(current.files.items).toHaveLength(1);
});

test("thread pages reject changed permission, resolution and line context even under the same PR revision", () => {
  const first = detail();
  const item = { ...first.discussion.items[0]!, kind: "review_comment" as const, path: "a.ts", line: 7, resolved: false,
    thread: { id: "thread-one", side: "RIGHT" as const, startSide: null, startLine: null, originalLine: 7, originalStartLine: null, canReply: true, canResolve: true, canUnresolve: false } };
  first.discussion.items = [item];
  const next = structuredClone(first); next.discussion.items[0]!.id = "next-comment";
  expect(appendPullRequestDetail(first, next, "discussion").discussion.items.map(item => item.id)).toEqual([item.id, "next-comment"]);
  for (const change of [(item: typeof first.discussion.items[number]) => { item.thread!.canReply = false; }, (item: typeof first.discussion.items[number]) => { item.resolved = true; }, (item: typeof first.discussion.items[number]) => { item.line = 8; }]) {
    const changed = structuredClone(next); change(changed.discussion.items[0]!);
    expect(() => appendPullRequestDetail(first, changed, "discussion")).toThrow("thread changed");
  }
  expect(first.discussion.items).toEqual([item]);
});
