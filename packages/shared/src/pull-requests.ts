export const PULL_REQUESTS_CAPABILITY = { version: 1 } as const;
export const PULL_REQUESTS_HOST_HEADER = "X-Agent-Pull-Requests-Host";

export type PullRequestAvailabilityStatus =
  | "missing"
  | "unauthenticated"
  | "offline"
  | "ready"
  | "unavailable";
export type PullRequestView = "all" | "reviewing" | "authored";
export type PullRequestLifecycle = "all" | "open" | "merged" | "closed";
export type PullRequestRelationship =
  | "user_review_requested"
  | "team_review_requested"
  | "reviewed"
  | "authored"
  | "results";

export interface PullRequestAccount {
  id: string;
  hostname: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}
export interface PullRequestAvailability {
  status: PullRequestAvailabilityStatus;
  accounts: PullRequestAccount[];
  activeAccountId: string | null;
  message: string | null;
}
export interface PullRequestRepository {
  owner: string;
  repository: string;
}
export interface PullRequestIdentity extends PullRequestRepository {
  hostname: string;
  number: number;
}
export interface PullRequestActor {
  login: string | null;
  avatarUrl: string | null;
}
export interface PullRequestSummary {
  nodeId: string;
  pullRequest: PullRequestIdentity;
  url: string;
  title: string;
  author: PullRequestActor;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  baseBranch: string;
  headBranch: string;
  headOid: string;
  additions: number;
  deletions: number;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
}
export interface PullRequestPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
  truncated: boolean;
}
export interface PullRequestInboxSection {
  key: PullRequestRelationship;
  items: PullRequestSummary[];
  pageInfo: PullRequestPageInfo;
  error: string | null;
}
export interface PullRequestInboxFilters {
  view: PullRequestView;
  lifecycle: PullRequestLifecycle;
  repository: PullRequestRepository | null;
  search: string;
  rawQuery: string | null;
}
export interface PullRequestInboxRequest {
  type: "inbox";
  accountId: string;
  filters: PullRequestInboxFilters;
  after?: Partial<Record<PullRequestRelationship, string>>;
  pageSize: 50;
}
export interface PullRequestAccountsRequest {
  type: "accounts";
  refresh: boolean;
}

export interface PullRequestDiscussionItem {
  id: string;
  kind: "comment" | "review" | "review_comment" | "commit";
  author: PullRequestActor;
  body: string;
  createdAt: string;
  url: string | null;
  path: string | null;
  line: number | null;
  resolved: boolean | null;
}
export interface PullRequestCheck {
  id: string;
  name: string;
  workflow: string | null;
  state: string;
  bucket: "pass" | "fail" | "pending" | "cancel" | "skip" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
}
export interface PullRequestFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blobOid: string;
  patch:
    | { text: string }
    | { unavailableReason: "binary" | "too_large" | "not_returned" };
}
export interface PullRequestDetailRequest {
  type: "detail";
  accountId: string;
  pullRequest: PullRequestIdentity;
  expectedRevision?: string;
  after?: Partial<Record<"discussion" | "checks" | "files", string>>;
  pageSize: 50;
}
export type PullRequestReadRequest =
  | PullRequestAccountsRequest
  | PullRequestInboxRequest
  | PullRequestDetailRequest;
export interface PullRequestAccountsResult {
  type: "accounts";
  availability: PullRequestAvailability;
}
export interface PullRequestInboxResult {
  type: "inbox";
  account: PullRequestAccount;
  filters: PullRequestInboxFilters;
  sections: PullRequestInboxSection[];
}
export interface PullRequestDetailResult {
  type: "detail";
  account: PullRequestAccount;
  revision: string;
  summary: PullRequestSummary;
  body: string;
  discussion: {
    items: PullRequestDiscussionItem[];
    pageInfo: PullRequestPageInfo;
  };
  checks: { items: PullRequestCheck[]; pageInfo: PullRequestPageInfo };
  files: { items: PullRequestFile[]; pageInfo: PullRequestPageInfo };
}
export type PullRequestReadResult =
  | PullRequestAccountsResult
  | PullRequestInboxResult
  | PullRequestDetailResult;
export interface PullRequestsBridge {
  read(
    hostId: string,
    input: PullRequestReadRequest,
  ): Promise<PullRequestReadResult>;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
};
const exact = (
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
) => {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error(`Unsupported ${label} field.`);
};
const string = (
  value: unknown,
  label: string,
  max = 1024,
  empty = false,
): string => {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  )
    throw new Error(`Invalid ${label}.`);
  return value;
};
const enumValue = <T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`Invalid ${label}.`);
  return value as T;
};
const repository = (value: unknown): PullRequestRepository => {
  const input = object(value, "pull request repository");
  exact(input, ["owner", "repository"], "pull request repository");
  return {
    owner: string(input.owner, "repository owner", 100),
    repository: string(input.repository, "repository name", 100),
  };
};
const identity = (value: unknown): PullRequestIdentity => {
  const input = object(value, "pull request identity");
  exact(
    input,
    ["hostname", "owner", "repository", "number"],
    "pull request identity",
  );
  const repo = repository({ owner: input.owner, repository: input.repository });
  if (
    typeof input.number !== "number" ||
    !Number.isSafeInteger(input.number) ||
    input.number < 1
  )
    throw new Error("Invalid pull request number.");
  return {
    hostname: string(input.hostname, "GitHub hostname", 253),
    ...repo,
    number: input.number,
  };
};
const cursorMap = (value: unknown, keys: readonly string[]) => {
  if (value === undefined) return undefined;
  const input = object(value, "pull request cursors");
  exact(input, keys, "pull request cursor");
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      string(item, "pull request cursor", 2048),
    ]),
  );
};

export function parsePullRequestReadRequest(
  value: unknown,
): PullRequestReadRequest {
  const input = object(value, "pull request request");
  if (input.type === "accounts") {
    exact(input, ["type", "refresh"], "pull request accounts request");
    if (typeof input.refresh !== "boolean")
      throw new Error("Invalid pull request refresh value.");
    return { type: "accounts", refresh: input.refresh };
  }
  if (input.type === "inbox") {
    exact(
      input,
      ["type", "accountId", "filters", "after", "pageSize"],
      "pull request inbox request",
    );
    if (input.pageSize !== 50)
      throw new Error("Pull request page size must be 50.");
    const f = object(input.filters, "pull request filters");
    exact(
      f,
      ["view", "lifecycle", "repository", "search", "rawQuery"],
      "pull request filter",
    );
    const filters: PullRequestInboxFilters = {
      view: enumValue(
        f.view,
        ["all", "reviewing", "authored"],
        "pull request view",
      ),
      lifecycle: enumValue(
        f.lifecycle,
        ["all", "open", "merged", "closed"],
        "pull request lifecycle",
      ),
      repository: f.repository === null ? null : repository(f.repository),
      search: string(f.search, "pull request search", 256, true),
      rawQuery:
        f.rawQuery === null
          ? null
          : string(f.rawQuery, "raw pull request query", 256, true),
    };
    return {
      type: "inbox",
      accountId: string(input.accountId, "pull request account", 128),
      filters,
      pageSize: 50,
      ...(input.after === undefined
        ? {}
        : {
            after: cursorMap(input.after, [
              "user_review_requested",
              "team_review_requested",
              "reviewed",
              "authored",
              "results",
            ]),
          }),
    };
  }
  if (input.type === "detail") {
    exact(
      input,
      [
        "type",
        "accountId",
        "pullRequest",
        "expectedRevision",
        "after",
        "pageSize",
      ],
      "pull request detail request",
    );
    if (input.pageSize !== 50)
      throw new Error("Pull request page size must be 50.");
    if (input.after !== undefined && input.expectedRevision === undefined)
      throw new Error(
        "Paginated pull request detail requires its reviewed revision.",
      );
    return {
      type: "detail",
      accountId: string(input.accountId, "pull request account", 128),
      pullRequest: identity(input.pullRequest),
      pageSize: 50,
      ...(input.expectedRevision === undefined
        ? {}
        : {
            expectedRevision: string(
              input.expectedRevision,
              "pull request revision",
              128,
            ),
          }),
      ...(input.after === undefined
        ? {}
        : { after: cursorMap(input.after, ["discussion", "checks", "files"]) }),
    };
  }
  throw new Error("Unknown pull request request.");
}

const nullableString = (
  value: unknown,
  label: string,
  max = 4096,
): string | null => (value === null ? null : string(value, label, max, true));
const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new Error(`Invalid ${label}.`);
  return value;
};
const nonnegative = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}.`);
  return value;
};
const array = <T>(
  value: unknown,
  label: string,
  max: number,
  parse: (item: unknown, index: number) => T,
): T[] => {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return Array.from({ length: value.length }, (_, index) =>
    parse(value[index], index),
  );
};
const actor = (value: unknown): PullRequestActor => {
  const input = object(value, "pull request actor");
  exact(input, ["login", "avatarUrl"], "pull request actor");
  return {
    login: nullableString(input.login, "actor login", 100),
    avatarUrl: nullableString(input.avatarUrl, "actor avatar URL", 4096),
  };
};
const account = (value: unknown): PullRequestAccount => {
  const input = object(value, "pull request account");
  exact(
    input,
    ["id", "hostname", "login", "name", "avatarUrl"],
    "pull request account",
  );
  return {
    id: string(input.id, "account ID", 128),
    hostname: string(input.hostname, "GitHub hostname", 253),
    login: string(input.login, "account login", 100),
    name: nullableString(input.name, "account name", 256),
    avatarUrl: nullableString(input.avatarUrl, "account avatar URL", 4096),
  };
};
const pageInfo = (value: unknown): PullRequestPageInfo => {
  const input = object(value, "pull request page");
  exact(
    input,
    ["hasNextPage", "endCursor", "totalCount", "truncated"],
    "pull request page",
  );
  if (
    typeof input.hasNextPage !== "boolean" ||
    typeof input.truncated !== "boolean"
  )
    throw new Error("Invalid pull request page state.");
  return {
    hasNextPage: input.hasNextPage,
    endCursor: nullableString(input.endCursor, "page cursor", 2048),
    totalCount: nonnegative(input.totalCount, "page total"),
    truncated: input.truncated,
  };
};
const summary = (value: unknown): PullRequestSummary => {
  const input = object(value, "pull request summary");
  exact(
    input,
    [
      "nodeId",
      "pullRequest",
      "url",
      "title",
      "author",
      "state",
      "isDraft",
      "createdAt",
      "updatedAt",
      "baseBranch",
      "headBranch",
      "headOid",
      "additions",
      "deletions",
      "reviewDecision",
    ],
    "pull request summary",
  );
  if (typeof input.isDraft !== "boolean")
    throw new Error("Invalid pull request draft state.");
  const reviewDecision: PullRequestSummary["reviewDecision"] =
    input.reviewDecision === null
      ? null
      : enumValue(
          input.reviewDecision,
          ["approved", "changes_requested", "review_required"] as const,
          "review decision",
        );
  return {
    nodeId: string(input.nodeId, "pull request node ID", 256),
    pullRequest: identity(input.pullRequest),
    url: string(input.url, "pull request URL", 4096),
    title: string(input.title, "pull request title", 1024, true),
    author: actor(input.author),
    state: enumValue(
      input.state,
      ["open", "merged", "closed"] as const,
      "pull request state",
    ),
    isDraft: input.isDraft,
    createdAt: string(input.createdAt, "pull request creation time", 128),
    updatedAt: string(input.updatedAt, "pull request update time", 128),
    baseBranch: string(input.baseBranch, "base branch", 1024, true),
    headBranch: string(input.headBranch, "head branch", 1024, true),
    headOid: string(input.headOid, "head object ID", 128),
    additions: nonnegative(input.additions, "pull request additions"),
    deletions: nonnegative(input.deletions, "pull request deletions"),
    reviewDecision,
  };
};

export function parsePullRequestReadResult(
  value: unknown,
  request: PullRequestReadRequest,
): PullRequestReadResult {
  const input = object(value, "pull request result");
  if (input.type !== request.type)
    throw new Error("Pull request response type does not match the request.");
  if (request.type === "accounts") {
    exact(input, ["type", "availability"], "pull request accounts result");
    const a = object(input.availability, "pull request availability");
    exact(
      a,
      ["status", "accounts", "activeAccountId", "message"],
      "pull request availability",
    );
    const accounts = array(a.accounts, "pull request accounts", 32, account);
    const activeAccountId = nullableString(
      a.activeAccountId,
      "active account ID",
      128,
    );
    if (
      activeAccountId !== null &&
      !accounts.some((item) => item.id === activeAccountId)
    )
      throw new Error("Active pull request account is missing.");
    return {
      type: "accounts",
      availability: {
        status: enumValue(
          a.status,
          ["missing", "unauthenticated", "offline", "ready", "unavailable"],
          "pull request availability",
        ),
        accounts,
        activeAccountId,
        message: nullableString(
          a.message,
          "pull request availability message",
          1024,
        ),
      },
    };
  }
  if (request.type === "inbox") {
    exact(
      input,
      ["type", "account", "filters", "sections"],
      "pull request inbox result",
    );
    const parsedAccount = account(input.account);
    if (parsedAccount.id !== request.accountId)
      throw new Error("Pull request account changed.");
    const parsedRequest = parsePullRequestReadRequest({
      type: "inbox",
      accountId: request.accountId,
      filters: input.filters,
      pageSize: 50,
    });
    if (parsedRequest.type !== "inbox")
      throw new Error("Invalid pull request filters.");
    const filters = parsedRequest.filters;
    if (JSON.stringify(filters) !== JSON.stringify(request.filters))
      throw new Error("Pull request filters changed.");
    const baseAllowed: PullRequestRelationship[] = hasRelationshipQualifier(
      request.filters.rawQuery,
    )
      ? ["results"]
      : request.filters.view === "authored"
        ? ["authored"]
        : request.filters.view === "reviewing"
          ? ["user_review_requested", "team_review_requested", "reviewed"]
          : [
              "user_review_requested",
              "team_review_requested",
              "reviewed",
              "authored",
            ];
    const requested =
      request.after && Object.keys(request.after).length
        ? baseAllowed.filter((key) => request.after?.[key] !== undefined)
        : baseAllowed;
    const sections = array(
      input.sections,
      "pull request sections",
      5,
      (item) => {
        const section = object(item, "pull request section");
        exact(
          section,
          ["key", "items", "pageInfo", "error"],
          "pull request section",
        );
        const key = enumValue(
          section.key,
          [
            "user_review_requested",
            "team_review_requested",
            "reviewed",
            "authored",
            "results",
          ],
          "pull request section",
        );
        const items = array(section.items, "pull requests", 50, summary);
        if (new Set(items.map((item) => item.nodeId)).size !== items.length)
          throw new Error("Duplicate pull request result.");
        return {
          key,
          items,
          pageInfo: pageInfo(section.pageInfo),
          error: nullableString(
            section.error,
            "pull request section error",
            1024,
          ),
        };
      },
    );
    if (
      sections.some((section, index) => section.key !== requested[index]) ||
      sections.length !== requested.length
    )
      throw new Error("Pull request sections do not match the requested view.");
    return { type: "inbox", account: parsedAccount, filters, sections };
  }
  exact(
    input,
    [
      "type",
      "account",
      "revision",
      "summary",
      "body",
      "discussion",
      "checks",
      "files",
    ],
    "pull request detail result",
  );
  const parsedAccount = account(input.account);
  if (parsedAccount.id !== request.accountId)
    throw new Error("Pull request account changed.");
  const parsedSummary = summary(input.summary);
  if (
    JSON.stringify(parsedSummary.pullRequest) !==
    JSON.stringify(request.pullRequest)
  )
    throw new Error("Pull request identity changed.");
  const revision = string(input.revision, "pull request revision", 128);
  if (
    request.expectedRevision !== undefined &&
    revision !== request.expectedRevision
  )
    throw new Error("Pull request head changed.");
  const collection = <T>(
    value: unknown,
    label: string,
    max: number,
    parse: (item: unknown) => T,
  ) => {
    const c = object(value, label);
    exact(c, ["items", "pageInfo"], label);
    return {
      items: array(c.items, label, max, parse),
      pageInfo: pageInfo(c.pageInfo),
    };
  };
  const discussion = collection(
    input.discussion,
    "pull request discussion",
    2500,
    (item) => {
      const d = object(item, "discussion item");
      exact(
        d,
        [
          "id",
          "kind",
          "author",
          "body",
          "createdAt",
          "url",
          "path",
          "line",
          "resolved",
        ],
        "discussion item",
      );
      if (
        d.line !== null &&
        (typeof d.line !== "number" ||
          !Number.isSafeInteger(d.line) ||
          d.line < 1)
      )
        throw new Error("Invalid discussion line.");
      if (d.resolved !== null && typeof d.resolved !== "boolean")
        throw new Error("Invalid discussion resolution.");
      return {
        id: string(d.id, "discussion ID", 256),
        kind: enumValue(
          d.kind,
          ["comment", "review", "review_comment", "commit"],
          "discussion kind",
        ),
        author: actor(d.author),
        body: text(d.body, "discussion body", 256 * 1024),
        createdAt: string(d.createdAt, "discussion creation time", 128),
        url: nullableString(d.url, "discussion URL", 4096),
        path: nullableString(d.path, "discussion path", 4096),
        line: d.line as number | null,
        resolved: d.resolved as boolean | null,
      };
    },
  );
  const checks = collection(input.checks, "pull request checks", 50, (item) => {
    const c = object(item, "pull request check");
    exact(
      c,
      [
        "id",
        "name",
        "workflow",
        "state",
        "bucket",
        "startedAt",
        "completedAt",
        "url",
      ],
      "pull request check",
    );
    return {
      id: string(c.id, "check ID", 512),
      name: string(c.name, "check name", 1024, true),
      workflow: nullableString(c.workflow, "check workflow", 1024),
      state: string(c.state, "check state", 128, true),
      bucket: enumValue(
        c.bucket,
        ["pass", "fail", "pending", "cancel", "skip", "unknown"],
        "check bucket",
      ),
      startedAt: nullableString(c.startedAt, "check start time", 128),
      completedAt: nullableString(c.completedAt, "check completion time", 128),
      url: nullableString(c.url, "check URL", 4096),
    };
  });
  const files = collection(input.files, "pull request files", 50, (item) => {
    const f = object(item, "pull request file");
    exact(
      f,
      [
        "path",
        "previousPath",
        "status",
        "additions",
        "deletions",
        "changes",
        "blobOid",
        "patch",
      ],
      "pull request file",
    );
    const patch = object(f.patch, "file patch");
    if (Object.hasOwn(patch, "text")) {
      exact(patch, ["text"], "file patch");
      return {
        path: string(f.path, "file path", 4096),
        previousPath: nullableString(
          f.previousPath,
          "previous file path",
          4096,
        ),
        status: string(f.status, "file status", 64),
        additions: nonnegative(f.additions, "file additions"),
        deletions: nonnegative(f.deletions, "file deletions"),
        changes: nonnegative(f.changes, "file changes"),
        blobOid: string(f.blobOid, "file blob ID", 128),
        patch: { text: text(patch.text, "file patch", 256 * 1024) },
      };
    }
    exact(patch, ["unavailableReason"], "file patch");
    return {
      path: string(f.path, "file path", 4096),
      previousPath: nullableString(f.previousPath, "previous file path", 4096),
      status: string(f.status, "file status", 64),
      additions: nonnegative(f.additions, "file additions"),
      deletions: nonnegative(f.deletions, "file deletions"),
      changes: nonnegative(f.changes, "file changes"),
      blobOid: string(f.blobOid, "file blob ID", 128),
      patch: {
        unavailableReason: enumValue(
          patch.unavailableReason,
          ["binary", "too_large", "not_returned"],
          "file patch availability",
        ),
      },
    };
  });
  return {
    type: "detail",
    account: parsedAccount,
    revision,
    summary: parsedSummary,
    body: text(input.body, "pull request body", 1024 * 1024),
    discussion,
    checks,
    files,
  };
}

const RELATIONSHIP_QUALIFIERS = new Set([
  "assignee",
  "author",
  "commenter",
  "involves",
  "mentions",
  "review-involves",
  "review-requested",
  "reviewed-by",
  "team",
  "team-review-requested",
  "user-review-requested",
]);
/** Matches native search syntax without interpreting qualifier-like text inside
 * double quoted phrases. This determines section layout, not API authorization. */
export function pullRequestQualifierNames(
  rawQuery: string | null,
): Set<string> {
  const source = (rawQuery ?? "").replaceAll(/"(?:\\.|[^"\\])*(?:"|$)/gu, "");
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:^|[\s(])-?([a-z-]+):/giu))
    names.add(match[1]!.toLowerCase());
  return names;
}
export function hasRelationshipQualifier(rawQuery: string | null): boolean {
  return [...pullRequestQualifierNames(rawQuery)].some((name) =>
    RELATIONSHIP_QUALIFIERS.has(name),
  );
}
