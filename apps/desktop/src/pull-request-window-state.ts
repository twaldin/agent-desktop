import {
  parsePullRequestReadRequest,
  type PullRequestIdentity,
  type PullRequestInboxFilters,
} from "../../../packages/shared/src/pull-requests";

/** Presentation preferences only. Restoring a selection never grants GitHub account authority. */
export interface PullRequestWindowView {
  hostId: string;
  accountId: string | null;
  filters: PullRequestInboxFilters;
  selected: PullRequestIdentity | null;
}
export const defaultPullRequestFilters = (): PullRequestInboxFilters => ({
  view: "all",
  lifecycle: "open",
  repository: null,
  search: "",
  rawQuery: null,
});
export function parsePullRequestWindowViews(
  value: unknown,
): PullRequestWindowView[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Invalid saved pull request views.");
  const views = Array.from(value, (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.hostId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.hostId) ||
      !(
        input.accountId === null ||
        (typeof input.accountId === "string" &&
          input.accountId.length > 0 &&
          input.accountId.length <= 128)
      )
    )
      throw new Error("Invalid pull request view owner.");
    const accountId = input.accountId ?? "restored-presentation";
    const query = parsePullRequestReadRequest({
      type: "inbox",
      accountId,
      filters: input.filters,
      pageSize: 50,
    });
    const detail =
      input.selected === null
        ? null
        : parsePullRequestReadRequest({
            type: "detail",
            accountId,
            pullRequest: input.selected,
            pageSize: 50,
          });
    if (query.type !== "inbox" || (detail && detail.type !== "detail"))
      throw new Error("Invalid pull request view.");
    return {
      hostId: input.hostId,
      accountId: input.accountId,
      filters: query.filters,
      selected: detail?.pullRequest ?? null,
    };
  });
  if (new Set(views.map((view) => view.hostId)).size !== views.length)
    throw new Error("Duplicate pull request view owner.");
  return views;
}
