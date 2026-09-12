import type {
  PullRequestInboxFilters,
  PullRequestInboxSection,
  PullRequestSummary,
} from "../../../../packages/shared/src/pull-requests";

const qualifiers = new Set(
  "archived assignee author base checks closed commenter comments created draft head in interactions involves is label language linked merged mentions milestone no org project reactions repo review review-involves review-requested reviewed-by sort state status team team-review-requested type updated user user-review-requested".split(
    " ",
  ),
);
const relationship = new Set(
  "assignee author commenter involves mentions review-involves review-requested reviewed-by team team-review-requested user-review-requested".split(
    " ",
  ),
);
/** Quoted prose stays text; explicit GitHub qualifiers override only their matching controls. */
export function pullRequestQuery(
  value: PullRequestInboxFilters,
  search = value.search,
) {
  const unquoted = search.replaceAll(/"(?:\\.|[^"\\])*(?:"|$)/gu, "");
  const names = Array.from(
    unquoted.matchAll(/(?:^|[\s(])-?([a-z-]+):/giu),
    (item) => item[1]!.toLowerCase(),
  ).filter((name) => qualifiers.has(name));
  const explicitLifecycle =
    names.some((name) =>
      ["closed", "draft", "merged", "state"].includes(name),
    ) ||
    /(?:^|[\s(])-?is:(?:closed|draft|merged|open|unmerged)\b/iu.test(unquoted);
  return {
    filters: {
      ...value,
      search,
      rawQuery: names.length ? search : null,
      lifecycle: explicitLifecycle
        ? ("all" as const)
        : value.view === "reviewing"
          ? ("open" as const)
          : value.lifecycle,
      repository: names.some((name) => ["org", "repo", "user"].includes(name))
        ? null
        : value.repository,
    },
    explicitLifecycle,
    explicitRelationship: names.some((name) => relationship.has(name)),
  };
}
/** Priority matches the inbox: direct requests, team requests, previously reviewed, authored. */
export function visiblePullRequestSections(
  sections: PullRequestInboxSection[],
): PullRequestInboxSection[] {
  const direct = sections.find(
    (section) => section.key === "user_review_requested",
  );
  const team = sections.find(
    (section) => section.key === "team_review_requested",
  );
  const seen = new Set<string>();
  const take = (items: PullRequestSummary[]) =>
    items.filter((item) => {
      if (seen.has(item.nodeId)) return false;
      seen.add(item.nodeId);
      return true;
    });
  return sections.map((section) => {
    if (section.key === "user_review_requested")
      return {
        ...section,
        items: take(
          direct?.error
            ? [...section.items, ...(team?.items ?? [])]
            : section.items,
        ),
      };
    if (section.key === "team_review_requested" && (!direct || direct.error))
      return { ...section, items: [] };
    return { ...section, items: take(section.items) };
  });
}
