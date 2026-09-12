import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowStateStore } from "./window-state";
import { defaultWindowView } from "../window-state";
import { defaultPullRequestFilters } from "../pull-request-window-state";
import { summary } from "../../../../scripts/acceptance/pull-requests/data";
test("window save and reopen preserve PR selection and filters without persisting read credentials or accepting holes", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-pr-window-"));
  try {
    const store = new WindowStateStore(root, "primary");
    const view = {
      hostId: "host-a",
      accountId: "account-a",
      filters: { ...defaultPullRequestFilters(), search: "owner change" },
      selected: summary().pullRequest,
    };
    expect(
      store.saveView({
        ...defaultWindowView(),
        pullRequestsOpen: true,
        pullRequestViews: [view],
        token: "private-token",
      }),
    ).toEqual({});
    const prior = readFileSync(store.file, "utf8");
    expect(prior).not.toContain("private-token");
    const restored = new WindowStateStore(root, "primary").bootstrap();
    expect(restored.state).toMatchObject({
      pullRequestsOpen: true,
      pullRequestViews: [view],
    });
    for (const invalid of [new Array(1), [view, ,], [view, view]]) {
      expect(
        store.saveView({ ...defaultWindowView(), pullRequestViews: invalid }),
      ).toHaveProperty("error");
      expect(readFileSync(store.file, "utf8")).toBe(prior);
    }
    restored.state!.pullRequestViews![0]!.filters.search = "mutated";
    expect(
      new WindowStateStore(root, "primary").bootstrap().state!
        .pullRequestViews![0]!.filters.search,
    ).toBe("owner change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
