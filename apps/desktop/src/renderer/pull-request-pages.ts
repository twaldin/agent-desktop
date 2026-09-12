import type {
  PullRequestDetailResult,
  PullRequestIdentity,
  PullRequestInboxResult,
} from "../../../../packages/shared/src/pull-requests";

export const pullRequestKey = (value: PullRequestIdentity) =>
  JSON.stringify([
    value.hostname.toLowerCase(),
    value.owner.toLowerCase(),
    value.repository.toLowerCase(),
    value.number,
  ]);
const unique = <T>(entries: T[], key: (entry: T) => string): T[] => [
  ...new Map(entries.map((entry) => [key(entry), entry])).values(),
];
function bounded<T>(value: T): T {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    12 * 1024 * 1024
  )
    throw new Error(
      "These results reached the display limit. Narrow the search or open the pull request on GitHub.",
    );
  return value;
}
/** A page can only extend the exact account/filter or original revision it was requested for. */
export function appendPullRequestInbox(
  previous: PullRequestInboxResult,
  next: PullRequestInboxResult,
): PullRequestInboxResult {
  if (
    previous.account.id !== next.account.id ||
    JSON.stringify(previous.filters) !== JSON.stringify(next.filters)
  )
    throw new Error(
      "The pull request search changed. Refresh before loading more.",
    );
  const sections = new Map(
    previous.sections.map((section) => [section.key, section]),
  );
  for (const section of next.sections) {
    const old = previous.sections.find((item) => item.key === section.key);
    if (
      old?.pageInfo.endCursor &&
      section.pageInfo.hasNextPage &&
      old.pageInfo.endCursor === section.pageInfo.endCursor
    )
      throw new Error(
        "GitHub returned the same search cursor. Refresh before loading more.",
      );
    const items = unique(
      [...(old?.items ?? []), ...section.items],
      (item) => item.nodeId,
    );
    if (items.length > 1000)
      throw new Error(
        "This search reached GitHub’s 1,000 result limit. Narrow the search to continue.",
      );
    sections.set(section.key, { ...section, items });
  }
  return bounded({ ...next, sections: [...sections.values()] });
}
export function appendPullRequestDetail(
  previous: PullRequestDetailResult,
  next: PullRequestDetailResult,
  section: "discussion" | "checks" | "files",
): PullRequestDetailResult {
  if (
    previous.account.id !== next.account.id ||
    previous.revision !== next.revision ||
    pullRequestKey(previous.summary.pullRequest) !==
      pullRequestKey(next.summary.pullRequest)
  )
    throw new Error("The pull request changed. Refresh before loading more.");
  if (
    previous[section].pageInfo.endCursor &&
    next[section].pageInfo.hasNextPage &&
    previous[section].pageInfo.endCursor === next[section].pageInfo.endCursor
  )
    throw new Error(
      "GitHub returned the same detail cursor. Refresh before loading more.",
    );
  if (section === "discussion") {
    const threadState = (item: PullRequestDetailResult["discussion"]["items"][number]) => JSON.stringify([item.path, item.line, item.resolved, item.thread]);
    const previousThreads = new Map(previous.discussion.items.filter(item => item.thread).map(item => [item.thread!.id, threadState(item)]));
    for (const item of next.discussion.items) if (item.thread && previousThreads.has(item.thread.id) && previousThreads.get(item.thread.id) !== threadState(item))
      throw new Error("The review thread changed. Refresh before loading more replies.");
  }
  const merged =
    section === "files"
      ? unique(
          [...previous.files.items, ...next.files.items],
          (item) => item.path,
        )
      : section === "checks"
        ? unique(
            [...previous.checks.items, ...next.checks.items],
            (item) => item.id,
          )
        : unique(
            [...previous.discussion.items, ...next.discussion.items],
            (item) => item.id,
          );
  if (merged.length > 3000)
    throw new Error(
      "This section reached its display limit. Open the pull request on GitHub for the remaining items.",
    );
  return bounded({
    ...previous,
    [section]: {
      ...next[section],
      items: merged,
      pageInfo: {
        ...next[section].pageInfo,
        truncated:
          previous[section].pageInfo.truncated ||
          next[section].pageInfo.truncated,
      },
    },
  });
}
