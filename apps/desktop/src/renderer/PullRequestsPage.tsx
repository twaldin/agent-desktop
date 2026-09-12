import { PullRequestIcon, PullRequestFilterIcon } from "./pull-request-icons";
export { PullRequestIcon } from "./pull-request-icons";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type {
  PullRequestAvailability,
  PullRequestDetailResult,
  PullRequestFile,
  PullRequestIdentity,
  PullRequestInboxResult,
  PullRequestRelationship,
  PullRequestSummary,
} from "../../../../packages/shared/src/pull-requests";
import {
  defaultPullRequestFilters,
  type PullRequestWindowView,
} from "../pull-request-window-state";
import {
  appendPullRequestDetail,
  appendPullRequestInbox,
  pullRequestKey,
} from "./pull-request-pages";
import {
  pullRequestQuery,
  visiblePullRequestSections,
} from "./pull-request-query";
import {
  PullRequestCache,
  pullRequestSnapshotForView,
} from "./pull-request-cache";
import { Icon } from "./Icons";
import { MarkdownText, TranscriptMarkdownContext } from "./MarkdownText";
import { ReviewDiff, ReviewDiffs } from "./ReviewDiff";
import { DEFAULT_REVIEW_OPTIONS, parseReviewPatch } from "./review-model";
import "./pull-requests.css";

const sectionNames: Record<PullRequestRelationship, string> = {
  user_review_requested: "Needs my review",
  team_review_requested: "Needs my team’s review",
  reviewed: "Previously reviewed",
  authored: "Authored",
  results: "Results",
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The pull request could not be loaded.";
export function PullRequestsPage({
  bridge,
  hostId,
  hostName,
  hosts,
  connected,
  supported,
  initial,
  cache,
  onChanged,
  onSelectHost,
  onClose,
}: {
  bridge: DesktopBridge;
  hostId: string;
  hostName: string;
  hosts: { id: string; name: string }[];
  connected: boolean;
  supported: boolean;
  initial?: PullRequestWindowView;
  cache: PullRequestCache;
  onChanged(view: PullRequestWindowView): void;
  onSelectHost(id: string): void;
  onClose(): void;
}) {
  const [view, setView] = useState<PullRequestWindowView>(
    () =>
      initial ?? {
        hostId,
        accountId: null,
        filters: defaultPullRequestFilters(),
        selected: null,
      },
  );
  const saved = useRef(pullRequestSnapshotForView(cache.get(hostId), view));
  const [availability, setAvailability] = useState<
    PullRequestAvailability | undefined
  >(saved.current?.availability);
  const [inbox, setInbox] = useState<PullRequestInboxResult | undefined>(
    saved.current?.inbox,
  );
  const [detail, setDetail] = useState<PullRequestDetailResult | undefined>(
    saved.current?.detail,
  );
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(
    () => cache.put(hostId, { availability, inbox, detail }),
    [cache, hostId, availability, inbox, detail],
  );
  const [error, setError] = useState<{
    accounts?: string;
    inbox?: string;
    detail?: string;
    external?: string;
  }>({});
  const [loading, setLoading] = useState({
    accounts: false,
    inbox: false,
    detail: false,
  });
  const [tab, setTab] = useState<"overview" | "files">("overview");
  const [search, setSearch] = useState(view.filters.search);
  const context = useRef(0),
    tokens = useRef({ accounts: 0, inbox: 0, detail: 0 }),
    enabled = connected && supported && !!bridge.pullRequests;
  const account = availability?.accounts.find(
    (item) => item.id === view.accountId,
  );
  const callback = useRef(onChanged);
  callback.current = onChanged;
  useEffect(() => callback.current(view), [view]);
  useLayoutEffect(() => {
    context.current++;
    tokens.current.accounts++;
    tokens.current.inbox++;
    tokens.current.detail++;
    setAccountConfirmed(false);
    setLoading({ accounts: false, inbox: false, detail: false });
    return () => {
      context.current++;
    };
  }, [hostId, bridge.pullRequests, connected, supported]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(view.filters.search), 200);
    return () => clearTimeout(timer);
  }, [view.filters.search]);
  async function accounts(refresh = true) {
    if (!enabled) return;
    const owner = context.current,
      token = ++tokens.current.accounts;
    setLoading((old) => ({ ...old, accounts: true }));
    setError((old) => ({ ...old, accounts: undefined }));
    try {
      const result = await bridge.pullRequests!.read(hostId, {
        type: "accounts",
        refresh,
      });
      if (owner !== context.current || token !== tokens.current.accounts)
        return;
      if (result.type !== "accounts")
        throw new Error("The GitHub account response is invalid.");
      setAvailability(result.availability);
      const old = currentView.current;
      const id = result.availability.accounts.some(
        (item) => item.id === old.accountId,
      )
        ? old.accountId
        : result.availability.activeAccountId;
      if (id !== old.accountId) {
        tokens.current.inbox++;
        tokens.current.detail++;
        setInbox(undefined);
        setDetail(undefined);
      }
      setView({
        ...old,
        accountId: id,
        selected: id === old.accountId ? old.selected : null,
      });
      setAccountConfirmed(result.availability.status === "ready");
    } catch (cause) {
      if (owner === context.current && token === tokens.current.accounts)
        setError((old) => ({ ...old, accounts: message(cause) }));
    } finally {
      if (owner === context.current && token === tokens.current.accounts)
        setLoading((old) => ({ ...old, accounts: false }));
    }
  }
  useEffect(() => {
    void accounts();
  }, [enabled, hostId, bridge.pullRequests]);
  const query = useMemo(
    () => pullRequestQuery(view.filters, search),
    [
      view.filters.view,
      view.filters.lifecycle,
      view.filters.repository?.owner,
      view.filters.repository?.repository,
      search,
    ],
  );
  const filters = query.filters;
  const filterKey = JSON.stringify(filters);
  async function loadInbox(more = false) {
    if (!enabled || !accountConfirmed || !account) return;
    const owner = context.current,
      token = ++tokens.current.inbox,
      prior = inbox;
    const after =
      more && prior
        ? Object.fromEntries(
            prior.sections
              .filter(
                (section) =>
                  section.pageInfo.hasNextPage && section.pageInfo.endCursor,
              )
              .map((section) => [section.key, section.pageInfo.endCursor!]),
          )
        : undefined;
    setLoading((old) => ({ ...old, inbox: true }));
    setError((old) => ({ ...old, inbox: undefined }));
    try {
      const result = await bridge.pullRequests!.read(hostId, {
        type: "inbox",
        accountId: account.id,
        filters,
        pageSize: 50,
        ...(after ? { after } : {}),
      });
      if (owner !== context.current || token !== tokens.current.inbox) return;
      if (result.type !== "inbox")
        throw new Error("The pull request search response is invalid.");
      setInbox(more && prior ? appendPullRequestInbox(prior, result) : result);
    } catch (cause) {
      if (owner === context.current && token === tokens.current.inbox)
        setError((old) => ({ ...old, inbox: message(cause) }));
    } finally {
      if (owner === context.current && token === tokens.current.inbox)
        setLoading((old) => ({ ...old, inbox: false }));
    }
  }
  const inboxScope = useRef(
    saved.current?.inbox
      ? `${saved.current.inbox.account.id}:${JSON.stringify(saved.current.inbox.filters)}`
      : "",
  );
  useEffect(() => {
    tokens.current.inbox++;
    const scope = `${account?.id}:${filterKey}`;
    if (inboxScope.current !== scope) {
      inboxScope.current = scope;
      setInbox(undefined);
    }
    void loadInbox();
  }, [enabled, accountConfirmed, account?.id, filterKey]);
  const selectedKey = view.selected ? pullRequestKey(view.selected) : "";
  async function loadDetail(section?: "discussion" | "checks" | "files") {
    if (!enabled || !accountConfirmed || !account || !view.selected) return;
    const owner = context.current,
      token = ++tokens.current.detail,
      prior = detail;
    const cursor = section && prior?.[section].pageInfo.endCursor;
    if (section && !cursor) return;
    setLoading((old) => ({ ...old, detail: true }));
    setError((old) => ({ ...old, detail: undefined }));
    try {
      const result = await bridge.pullRequests!.read(hostId, {
        type: "detail",
        accountId: account.id,
        pullRequest: view.selected,
        pageSize: 50,
        ...(section && prior && cursor
          ? { expectedRevision: prior.revision, after: { [section]: cursor } }
          : {}),
      });
      if (owner !== context.current || token !== tokens.current.detail) return;
      if (result.type !== "detail")
        throw new Error("The pull request detail response is invalid.");
      setDetail(
        section && prior
          ? appendPullRequestDetail(prior, result, section)
          : result,
      );
    } catch (cause) {
      if (owner === context.current && token === tokens.current.detail)
        setError((old) => ({ ...old, detail: message(cause) }));
    } finally {
      if (owner === context.current && token === tokens.current.detail)
        setLoading((old) => ({ ...old, detail: false }));
    }
  }
  const detailScope = useRef(
    saved.current?.detail
      ? `${saved.current.detail.account.id}:${pullRequestKey(saved.current.detail.summary.pullRequest)}`
      : "",
  );
  useEffect(() => {
    tokens.current.detail++;
    const scope = `${account?.id}:${selectedKey}`;
    if (detailScope.current !== scope) {
      detailScope.current = scope;
      setDetail(undefined);
      setTab("overview");
    }
    void loadDetail();
  }, [enabled, accountConfirmed, account?.id, selectedKey]);
  const refresh = useRef(() => {});
  refresh.current = () => {
    if (document.visibilityState === "visible") {
      void loadInbox();
      void loadDetail();
    }
  };
  useEffect(() => {
    if (!enabled || !accountConfirmed || !account) return;
    const onFocus = () => refresh.current(),
      timer = setInterval(onFocus, 60_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, accountConfirmed, account?.id]);
  function selectAccount(id: string) {
    tokens.current.inbox++;
    tokens.current.detail++;
    setInbox(undefined);
    setDetail(undefined);
    setView((old) => ({ ...old, accountId: id, selected: null }));
  }
  function changeFilters(next: Partial<PullRequestWindowView["filters"]>) {
    tokens.current.inbox++;
    setView((old) => ({ ...old, filters: { ...old.filters, ...next } }));
  }
  function select(pr: PullRequestIdentity) {
    if (view.selected && pullRequestKey(view.selected) === pullRequestKey(pr))
      return;
    tokens.current.detail++;
    setDetail(undefined);
    setView((old) => ({ ...old, selected: pr }));
  }
  async function external(url: string) {
    try {
      await bridge.openExternal(url);
      setError((old) => ({ ...old, external: undefined }));
    } catch (cause) {
      setError((old) => ({ ...old, external: message(cause) }));
    }
  }
  const repositories = new Map<string, { owner: string; repository: string }>();
  for (const section of inbox?.sections ?? [])
    for (const item of section.items)
      repositories.set(
        `${item.pullRequest.owner}/${item.pullRequest.repository}`,
        item.pullRequest,
      );
  if (view.filters.repository)
    repositories.set(
      `${view.filters.repository.owner}/${view.filters.repository.repository}`,
      view.filters.repository,
    );
  const visibleSections = inbox
    ? visiblePullRequestSections(inbox.sections)
    : [];
  const rows =
    visibleSections.reduce((sum, section) => sum + section.items.length, 0) ??
    0;
  return (
    <section className="pull-requests-page" aria-label="Pull requests">
      <div className="pull-requests-inbox">
        <header className="pull-requests-toolbar">
          <div role="group" aria-label="Pull request view">
            {(["all", "reviewing", "authored"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={view.filters.view === value}
                className={view.filters.view === value ? "selected" : ""}
                onClick={() => changeFilters({ view: value })}
              >
                {value === "all"
                  ? "All"
                  : value === "reviewing"
                    ? "Reviewing"
                    : "Authored"}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            aria-label="Refresh pull requests"
            disabled={!enabled || loading.inbox || loading.accounts}
            onClick={() => {
              void accounts();
              void loadInbox();
              void loadDetail();
            }}
          >
            <Icon name="refresh" />
          </button>
        </header>
        <div className="pull-requests-search">
          <Icon name="search" />
          <input
            aria-label="Search pull requests"
            placeholder="Search pull requests"
            maxLength={256}
            value={view.filters.search}
            onChange={(event) => changeFilters({ search: event.target.value })}
          />
        </div>
        <div className="pull-requests-filters">
          <PullRequestFilters
            value={view.filters}
            effectiveLifecycle={filters.lifecycle}
            statusDisabled={
              view.filters.view === "reviewing" || query.explicitLifecycle
            }
            repositories={repositories}
            onChange={changeFilters}
          />
        </div>
        <div className="pull-requests-owner">
          <select
            aria-label="Pull request execution host"
            value={hostId}
            onChange={(event) => onSelectHost(event.target.value)}
          >
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
          {availability?.accounts.length ? (
            <select
              aria-label="GitHub account"
              value={view.accountId ?? ""}
              onChange={(event) => selectAccount(event.target.value)}
            >
              {availability.accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.login} · {item.hostname}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {!connected && (
          <p role="status" className="pull-requests-notice">
            {hostName} is offline. Saved results are read-only until it
            reconnects.
          </p>
        )}
        {!supported && (
          <p role="status" className="pull-requests-notice">
            Update the host service to view pull requests here.
          </p>
        )}
        {error.accounts && (
          <p role="alert" className="pull-requests-notice">
            {error.accounts}
          </p>
        )}
        {!account && supported && (
          <div className="pull-requests-empty">
            <h2>
              {loading.accounts
                ? "Checking GitHub access"
                : "GitHub CLI setup required"}
            </h2>
            <p>
              {availability?.message ??
                `Install and sign in with GitHub CLI on ${hostName}, then check again.`}
            </p>
            <button
              className="secondary-button"
              disabled={!enabled || loading.accounts}
              onClick={() => void accounts()}
            >
              Check again
            </button>
          </div>
        )}
        {account && (
          <div
            className="pull-requests-list"
            aria-label="Pull request inbox"
            aria-busy={loading.inbox}
          >
            {error.inbox && (
              <p role="alert" className="pull-requests-notice">
                {error.inbox}{" "}
                <button disabled={!enabled} onClick={() => void loadInbox()}>
                  Try again
                </button>
              </p>
            )}
            {loading.inbox && !inbox && (
              <p role="status" className="pull-requests-notice">
                Loading pull requests…
              </p>
            )}
            {visibleSections.map((section) => (
              <section key={section.key} aria-label={sectionNames[section.key]}>
                <h3>
                  {sectionNames[section.key]}{" "}
                  <span>{section.items.length}</span>
                </h3>
                {section.error && (
                  <p role="alert" className="pull-requests-notice">
                    {section.error}
                  </p>
                )}
                {section.items.map((item) => (
                  <PullRequestRow
                    key={item.nodeId}
                    item={item}
                    selected={pullRequestKey(item.pullRequest) === selectedKey}
                    onSelect={() => select(item.pullRequest)}
                  />
                ))}
                {section.pageInfo.truncated && (
                  <p role="status" className="pull-requests-notice">
                    GitHub truncated these results. Narrow the search for the
                    rest.
                  </p>
                )}
              </section>
            ))}
            {inbox &&
              rows === 0 &&
              !inbox.sections.some((section) => section.error) && (
                <div className="pull-requests-empty">
                  {view.filters.search.trim()
                    ? "No pull requests match this search"
                    : view.filters.view === "reviewing"
                      ? "You’re all caught up"
                      : "No pull requests found"}
                </div>
              )}
            {inbox?.sections.some(
              (section) => section.pageInfo.hasNextPage,
            ) && (
              <button
                className="pull-requests-load-more"
                disabled={!enabled || loading.inbox}
                onClick={() => void loadInbox(true)}
              >
                {loading.inbox ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
        <footer>
          <strong>Pull requests</strong>
          <span>
            {account
              ? `Review and track work across GitHub as ${account.login}.`
              : "Review and track work across GitHub."}
          </span>
        </footer>
      </div>
      <div className="pull-request-detail">
        <header className="pull-request-detail-toolbar">
          <span>
            {detail
              ? `${detail.summary.pullRequest.owner}/${detail.summary.pullRequest.repository} #${detail.summary.pullRequest.number}`
              : "Pull requests"}
          </span>
          <button
            className="icon-button"
            aria-label="Close pull requests"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {error.detail && (
          <p role="alert" className="pull-requests-notice">
            {error.detail}{" "}
            <button disabled={!enabled} onClick={() => void loadDetail()}>
              Refresh
            </button>
          </p>
        )}
        {error.external && (
          <p role="alert" className="pull-requests-notice">
            {error.external}
          </p>
        )}
        {!detail ? (
          <div className="pull-requests-empty">
            <h2>
              {loading.detail
                ? "Loading pull request…"
                : view.selected && error.detail
                  ? "Couldn’t load this pull request"
                  : "Select pull request to view"}
            </h2>
          </div>
        ) : (
          <>
            <div className="pull-request-heading">
              <div>
                <span className={`pull-request-state ${detail.summary.state}`}>
                  {detail.summary.isDraft ? "Draft" : detail.summary.state}
                </span>
                <span>
                  {detail.summary.author.login ?? "Unknown author"} ·{" "}
                  {detail.summary.headBranch} → {detail.summary.baseBranch}
                </span>
              </div>
              <h1>{detail.summary.title}</h1>
              <button
                className="secondary-button"
                onClick={() => void external(detail.summary.url)}
              >
                Open on GitHub <Icon name="browserExternal" />
              </button>
            </div>
            <div
              className="pull-request-tabs"
              role="group"
              aria-label="Pull request sections"
            >
              <button
                aria-pressed={tab === "overview"}
                onClick={() => setTab("overview")}
              >
                Overview
              </button>
              <button
                aria-pressed={tab === "files"}
                onClick={() => setTab("files")}
              >
                Files changed <span>{detail.files.pageInfo.totalCount}</span>
              </button>
              <span className="pull-request-diff-count">
                <b>+{detail.summary.additions}</b>
                <em>−{detail.summary.deletions}</em>
              </span>
            </div>
            <div className="pull-request-detail-body">
              <TranscriptMarkdownContext
                value={{
                  actions: {
                    ownerKey: `pull-request:${hostId}:${detail.account.id}:${detail.revision}`,
                    openExternal: external,
                  },
                }}
              >
                {tab === "overview" ? (
                  <>
                    <section className="pull-request-description">
                      <h2>Description</h2>
                      {detail.body ? (
                        <MarkdownText
                          text={detail.body}
                          blockKey={`pr:${detail.revision}:body`}
                        />
                      ) : (
                        <p>No description provided</p>
                      )}
                    </section>
                    <section className="pull-request-checks">
                      <h2>Checks</h2>
                      {detail.checks.pageInfo.truncated && (
                        <p role="status">
                          Some checks were omitted by GitHub. Open the pull
                          request on GitHub for the complete list.
                        </p>
                      )}
                      {detail.checks.items.length ? (
                        detail.checks.items.map((check) => (
                          <div
                            key={check.id}
                            className={`pull-request-check ${check.bucket}`}
                          >
                            <span aria-label={check.bucket}>
                              {check.bucket === "pass"
                                ? "✓"
                                : check.bucket === "fail"
                                  ? "×"
                                  : check.bucket === "pending"
                                    ? "◷"
                                    : "−"}
                            </span>
                            <span>
                              {check.name}
                              <small>{check.workflow}</small>
                            </span>
                            <span>{check.state}</span>
                            {check.url && (
                              <button
                                className="icon-button"
                                aria-label={`Open check ${check.name}`}
                                onClick={() => void external(check.url!)}
                              >
                                <Icon name="browserExternal" />
                              </button>
                            )}
                          </div>
                        ))
                      ) : (
                        <p>No checks reported</p>
                      )}
                      {detail.checks.pageInfo.hasNextPage && (
                        <button
                          disabled={!enabled || loading.detail}
                          onClick={() => void loadDetail("checks")}
                        >
                          Load more checks
                        </button>
                      )}
                    </section>
                    <section className="pull-request-discussion">
                      <h2>Activity and comments</h2>
                      {detail.discussion.pageInfo.truncated && (
                        <p role="status">
                          Some discussion entries were omitted from this page.
                          Open the pull request on GitHub to read the full
                          discussion.
                        </p>
                      )}
                      {detail.discussion.items.length ? (
                        detail.discussion.items.map((item) => (
                          <article key={item.id}>
                            <header>
                              <strong>
                                {item.author.login ?? "Unknown author"}
                              </strong>
                              <time dateTime={item.createdAt}>
                                {new Date(item.createdAt).toLocaleString()}
                              </time>
                              {item.path && (
                                <span>
                                  {item.path}
                                  {item.line ? `:${item.line}` : ""}
                                </span>
                              )}
                              {item.resolved !== null && (
                                <span>
                                  {item.resolved ? "Resolved" : "Unresolved"}
                                </span>
                              )}
                            </header>
                            <MarkdownText
                              text={item.body}
                              blockKey={`pr:${detail.revision}:${item.id}`}
                            />
                            {item.url && (
                              <button onClick={() => void external(item.url!)}>
                                Open on GitHub
                              </button>
                            )}
                          </article>
                        ))
                      ) : (
                        <p>No comments</p>
                      )}
                      {detail.discussion.pageInfo.hasNextPage && (
                        <button
                          disabled={!enabled || loading.detail}
                          onClick={() => void loadDetail("discussion")}
                        >
                          Load more activity
                        </button>
                      )}
                    </section>
                  </>
                ) : (
                  <>
                    {detail.files.pageInfo.truncated && (
                      <p role="status">
                        GitHub truncated the changed files. Open the pull
                        request on GitHub for the complete list.
                      </p>
                    )}
                    <PullRequestFiles
                      files={detail.files.items}
                      revision={detail.revision}
                    />
                    {detail.files.pageInfo.hasNextPage && (
                      <button
                        disabled={!enabled || loading.detail}
                        onClick={() => void loadDetail("files")}
                      >
                        Load more files
                      </button>
                    )}
                  </>
                )}
              </TranscriptMarkdownContext>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
function PullRequestRow({
  item,
  selected,
  onSelect,
}: {
  item: PullRequestSummary;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={`pull-request-row ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={`pull-request-row-icon ${item.state}`}>
        <PullRequestIcon />
      </span>
      <span>
        <strong>{item.title}</strong>
        <small>
          {item.pullRequest.owner}/{item.pullRequest.repository} · #
          {item.pullRequest.number} · {item.author.login ?? "Unknown author"}
        </small>
        <small>
          {item.isDraft ? "Draft" : item.state}
          {item.reviewDecision
            ? ` · ${item.reviewDecision.replaceAll("_", " ")}`
            : ""}
        </small>
      </span>
      <time
        dateTime={item.updatedAt}
        title={new Date(item.updatedAt).toLocaleString()}
      >
        {new Date(item.updatedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}
      </time>
    </button>
  );
}

function PullRequestFiles({
  files,
  revision,
}: {
  files: PullRequestFile[];
  revision: string;
}) {
  const [split, setSplit] = useState(false),
    [collapsed, setCollapsed] = useState(new Set<string>());
  const options = { ...DEFAULT_REVIEW_OPTIONS, split };
  return (
    <div className="pull-request-files">
      <div className="pull-request-file-options">
        <button aria-pressed={split} onClick={() => setSplit(!split)}>
          {split ? "Unified diff" : "Split diff"}
        </button>
      </div>
      <ReviewDiffs options={options}>
        {files.map((file) => (
          <PullRequestFileDiff
            key={`${revision}:${file.path}`}
            file={file}
            revision={revision}
            collapsed={collapsed.has(file.path)}
            options={options}
            onToggle={() =>
              setCollapsed((old) => {
                const next = new Set(old);
                next.has(file.path)
                  ? next.delete(file.path)
                  : next.add(file.path);
                return next;
              })
            }
          />
        ))}
      </ReviewDiffs>
      {!files.length && <p>No file changes</p>}
    </div>
  );
}
function PullRequestFileDiff({
  file,
  revision,
  collapsed,
  options,
  onToggle,
}: {
  file: PullRequestFile;
  revision: string;
  collapsed: boolean;
  options: typeof DEFAULT_REVIEW_OPTIONS;
  onToggle(): void;
}) {
  const parsed = useMemo(() => {
    if (!("text" in file.patch))
      return { unavailable: file.patch.unavailableReason.replaceAll("_", " ") };
    try {
      const old = file.previousPath ?? file.path;
      const patch = `diff --git ${JSON.stringify(`a/${old}`)} ${JSON.stringify(`b/${file.path}`)}\n--- ${file.status === "added" ? "/dev/null" : JSON.stringify(`a/${old}`)}\n+++ ${file.status === "removed" ? "/dev/null" : JSON.stringify(`b/${file.path}`)}\n${file.patch.text}\n`;
      return {
        value: parseReviewPatch(patch, `${revision}:${file.path}`, file.path),
      };
    } catch (error) {
      return { error: message(error) };
    }
  }, [file, revision]);
  return (
    <article className="review-file">
      <header className="review-file-header">
        <button
          className="review-file-title"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <Icon name="chevron" className={collapsed ? "" : "open"} />
          <span>
            {file.previousPath && file.previousPath !== file.path
              ? `${file.previousPath} → `
              : ""}
            {file.path}
          </span>
        </button>
        <span className="review-file-counts">
          <span className="review-added">+{file.additions}</span>
          <span className="review-deleted">−{file.deletions}</span>
        </span>
      </header>
      {!collapsed &&
        (parsed.value?.files.map((value) => (
          <ReviewDiff key={value.key} file={value} options={options} />
        )) ?? (
          <p
            className="pull-requests-notice"
            role={parsed.error ? "alert" : "status"}
          >
            {parsed.error ??
              `Patch unavailable: ${parsed.unavailable}. Open the pull request on GitHub to inspect this file.`}
          </p>
        ))}
    </article>
  );
}

function PullRequestFilters({
  value,
  effectiveLifecycle,
  statusDisabled,
  repositories,
  onChange,
}: {
  value: PullRequestWindowView["filters"];
  effectiveLifecycle: PullRequestWindowView["filters"]["lifecycle"];
  statusDisabled: boolean;
  repositories: Map<string, { owner: string; repository: string }>;
  onChange(value: Partial<PullRequestWindowView["filters"]>): void;
}) {
  const selected = value.repository
    ? `${value.repository.owner}/${value.repository.repository}`
    : "";
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          className="icon-button"
          aria-label="Filter pull requests"
          title="Filter pull requests"
        >
          <PullRequestFilterIcon
            active={value.repository !== null || value.lifecycle !== "open"}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dock-add-menu pull-request-filter-menu"
          sideOffset={4}
          collisionPadding={8}
          align="start"
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              className="dock-add-item"
              disabled={statusDisabled}
            >
              Status
              <Icon name="chevron" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                className="dock-add-menu pull-request-filter-menu"
                sideOffset={4}
                collisionPadding={8}
              >
                {(["all", "open", "merged", "closed"] as const).map((state) => (
                  <DropdownMenu.Item
                    className="dock-add-item"
                    key={state}
                    onSelect={() => onChange({ lifecycle: state })}
                  >
                    {state === "all"
                      ? "All"
                      : state[0]!.toUpperCase() + state.slice(1)}
                    {effectiveLifecycle === state && <Icon name="check" />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="dock-add-item">
              Repository
              <Icon name="chevron" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                className="dock-add-menu pull-request-filter-menu"
                sideOffset={4}
                collisionPadding={8}
              >
                <DropdownMenu.Item
                  className="dock-add-item"
                  onSelect={() => onChange({ repository: null })}
                >
                  All repositories{!selected && <Icon name="check" />}
                </DropdownMenu.Item>
                {[...repositories]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, repository]) => (
                    <DropdownMenu.Item
                      className="dock-add-item"
                      key={key}
                      onSelect={() => onChange({ repository })}
                    >
                      {key}
                      {selected === key && <Icon name="check" />}
                    </DropdownMenu.Item>
                  ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
