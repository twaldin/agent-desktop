import { DISCUSSION_NODE_QUERY, discussionMutation, validateInlinePatch, PullRequestDiscussionError } from "./pull-request-discussion-write";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt,
  type PullRequestWriteRequest, type PullRequestWriteReceipt } from "../../../packages/shared/src/pull-request-write";
import type { PullRequestWriteRecords } from "./pull-request-write-records";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  hasRelationshipQualifier,
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
  pullRequestQualifierNames,
  type PullRequestAccount,
  type PullRequestDetailRequest,
  type PullRequestDetailResult,
  type PullRequestDiscussionItem,
  type PullRequestInboxRequest,
  type PullRequestInboxResult,
  type PullRequestInboxSection,
  type PullRequestReadRequest,
  type PullRequestReadResult,
  type PullRequestRelationship,
  type PullRequestSummary,
} from "../../../packages/shared/src/pull-requests";

const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const TIMEOUT_MS = 30_000;

export interface GhRunOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  stdoutLimit?: number;
}
export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}
export type GhRunner = (
  executable: string,
  args: string[],
  options: GhRunOptions,
) => Promise<GhRunResult>;

export class PullRequestReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PullRequestReadError";
  }
}

async function bounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  overflow: () => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        overflow();
        throw new PullRequestReadError(
          "TOO_LARGE",
          "GitHub returned more data than this app can safely read.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const runGh: GhRunner = async (executable, args, options) => {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false,
    overflow = false;
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  // Start the deadline only after spawn succeeds, and retain both pipe drains on every exit.
  const child = Bun.spawn([executable, ...args], {
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
    signal,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? TIMEOUT_MS);
  const exceed = () => {
    overflow = true;
    controller.abort();
  };
  const drains = [
    bounded(child.stdout, options.stdoutLimit ?? MAX_STDOUT, exceed),
    bounded(child.stderr, MAX_STDERR, exceed),
    child.exited,
  ] as const;
  const reads = Promise.all(drains);
  void reads.catch(() => {});
  try {
    if (options.input !== undefined) {
      const stdin = child.stdin;
      if (!stdin || typeof stdin === "number")
        throw new PullRequestReadError(
          "COMMAND_FAILED",
          "GitHub CLI input is unavailable.",
        );
      stdin.write(options.input);
      stdin.end();
    }
    const [stdout, stderr, exitCode] = await reads;
    options.signal?.throwIfAborted();
    return { exitCode, stdout, stderr, timedOut, overflow };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(drains);
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!(error instanceof PullRequestReadError) && !timedOut && !overflow)
      throw error;
    return {
      exitCode: child.exitCode ?? 1,
      stdout: "",
      stderr: "",
      timedOut,
      overflow,
    };
  } finally {
    clearTimeout(timer);
  }
};

interface Credential {
  account: PullRequestAccount;
  token: string;
  env: Record<string, string | undefined>;
}
interface Json {
  [key: string]: unknown;
}
const json = (text: string): Json => {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new PullRequestReadError(
      "INVALID_RESPONSE",
      "GitHub returned an invalid response.",
    );
  }
};
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => value[index])
    : [];
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
const iso = (value: unknown): string =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : new Date(0).toISOString();
const state = (value: unknown): "open" | "merged" | "closed" =>
  value === "MERGED" ? "merged" : value === "CLOSED" ? "closed" : "open";
const decision = (value: unknown) =>
  value === "APPROVED"
    ? ("approved" as const)
    : value === "CHANGES_REQUESTED"
      ? ("changes_requested" as const)
      : value === "REVIEW_REQUIRED"
        ? ("review_required" as const)
        : null;
const page = (connection: Json, count: number) => {
  const info = record(connection.pageInfo);
  const cursor = typeof info.endCursor === "string" ? info.endCursor : null;
  const has = info.hasNextPage === true && cursor !== null;
  return {
    hasNextPage: has,
    endCursor: has ? cursor : null,
    totalCount:
      integer(connection.totalCount ?? connection.issueCount) || count,
    truncated: info.hasNextPage === true && cursor === null,
  };
};
const actor = (value: unknown) => {
  const input = record(value);
  return {
    login: typeof input.login === "string" ? input.login : null,
    avatarUrl: typeof input.avatarUrl === "string" ? input.avatarUrl : null,
  };
};

const INBOX_QUERY = `query($searchQuery:String!,$first:Int!,$after:String){viewer{login} search(type:ISSUE,query:$searchQuery,first:$first,after:$after){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{id number url title state isDraft createdAt updatedAt additions deletions baseRefName headRefName headRefOid reviewDecision author{login avatarUrl} repository{name owner{login}} reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name slug}}}}}}}}`;
const DETAIL_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$commentsAfter:String,$reviewsAfter:String,$threadsAfter:String,$threadCommentsAfter:String,$checksAfter:String){viewer{login} repository(owner:$owner,name:$repo){pullRequest(number:$number){id number url title state isDraft createdAt updatedAt additions deletions baseRefName baseRefOid headRefName headRefOid reviewDecision body changedFiles author{login avatarUrl} comments(first:50,after:$commentsAfter){totalCount pageInfo{hasNextPage endCursor}nodes{id body createdAt url viewerCanUpdate viewerCanDelete author{login avatarUrl}}}reviews(first:50,after:$reviewsAfter){totalCount pageInfo{hasNextPage endCursor}nodes{id body state submittedAt createdAt url viewerCanUpdate author{login avatarUrl}}}reviewThreads(first:1,after:$threadsAfter){totalCount pageInfo{hasNextPage endCursor}nodes{id isResolved path line originalLine startLine originalStartLine diffSide startDiffSide viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:50,after:$threadCommentsAfter){nodes{id body createdAt url viewerCanUpdate viewerCanDelete author{login avatarUrl}}pageInfo{hasNextPage endCursor}}}}commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:50,after:$checksAfter){totalCount pageInfo{hasNextPage endCursor}nodes{__typename ... on CheckRun{id name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{workflow{name}}}} ... on StatusContext{id context state createdAt description targetUrl}}}}}}}}}}`;
const HEAD_QUERY = `query($owner:String!,$repo:String!,$number:Int!){viewer{login}repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid updatedAt}}}`;

export interface PullRequestsOptions {
  hostId: string;
  ghPath?: string;
  runner?: GhRunner;
  env?: NodeJS.ProcessEnv;
  writes?: PullRequestWriteRecords;
}
export class PullRequests {
  readonly #hostId: string;
  readonly #runner: GhRunner;
  readonly #configuredPath?: string;
  readonly #baseEnv: NodeJS.ProcessEnv;
  #accounts: PullRequestAccount[] = [];
  #activeAccountId: string | null = null;
  #path: string | null = null;
  #pathIdentity: string | null = null;
  #stopping = false;
  readonly #pending = new Map<AbortController, Promise<void>>();
  readonly #writes?: PullRequestWriteRecords;
  readonly #submissions = new Map<string, Promise<PullRequestWriteReceipt>>();
  readonly #writeTails = new Map<string, Promise<void>>();
  readonly #writeFailures: unknown[] = [];
  constructor(options: PullRequestsOptions) {
    this.#hostId = options.hostId;
    this.#writes = options.writes;
    this.#runner = options.runner ?? runGh;
    this.#configuredPath = options.ghPath;
    this.#baseEnv = options.env ?? process.env;
  }
  async read(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<PullRequestReadResult> {
    if (this.#stopping)
      throw new PullRequestReadError("STOPPING", "The host is stopping.");
    const request = parsePullRequestReadRequest(raw);
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const operation = (async () => {
      const result =
        request.type === "accounts"
          ? await this.#availability(request.refresh, combined)
          : request.type === "inbox"
            ? await this.#inbox(request, combined)
            : await this.#detail(request, combined);
      return parsePullRequestReadResult(result, request);
    })();
    this.#pending.set(
      controller,
      operation.then(
        () => {},
        () => {},
      ),
    );
    try {
      return await operation;
    } finally {
      this.#pending.delete(controller);
    }
  }
  async dispose() {
    this.#stopping = true;
    const pending = [...this.#pending.entries()];
    for (const [controller] of pending)
      controller.abort(
        new PullRequestReadError("STOPPING", "The host is stopping."),
      );
    await Promise.all(pending.map(([, settled]) => settled));
    this.#accounts = [];
    if (this.#writeFailures.length) throw new AggregateError(this.#writeFailures, "Pull request submission results could not be saved.");
  }
  status(raw: unknown): PullRequestWriteReceipt | null {
    const request = parsePullRequestWriteRequest(raw), records = this.#writeRecords();
    const record = records.get(request);
    return record ? record.receipt ?? records.unresolved(request, this.#submissions.has(request.requestId)) : null;
  }
  #writeRecords() {
    if (!this.#writes) throw new PullRequestReadError("UNAVAILABLE", "This host cannot submit pull requests.");
    return this.#writes;
  }
  async submit(raw: unknown, signal?: AbortSignal): Promise<PullRequestWriteReceipt> {
    const request = parsePullRequestWriteRequest(raw), records = this.#writeRecords();
    if (this.#stopping) throw new PullRequestReadError("STOPPING", "The host is stopping.");
    if (signal?.aborted) throw signal.reason;
    const prior = records.get(request);
    if (prior) return parsePullRequestWriteReceipt(await (this.#submissions.get(request.requestId) ?? prior.receipt ?? records.unresolved(request, false)), this.#hostId, request);
    if (this.#submissions.size >= 16) throw new PullRequestReadError("BUSY", "Wait for pending GitHub submissions to finish.");
    const claimed = records.claim(request);
    if (!claimed.fresh) return claimed.record.receipt ?? records.unresolved(request, false);
    // The durable reservation owns the call after admission, including after the requesting socket closes.
    const controller = new AbortController();
    const target = JSON.stringify([request.accountId, request.pullRequest.hostname.toLowerCase(), request.pullRequest.owner.toLowerCase(), request.pullRequest.repository.toLowerCase(), request.pullRequest.number]);
    const previous = this.#writeTails.get(target);
    const operation = Promise.resolve().then(async () => {
      await previous;
      let dispatched = false;
      let receipt: PullRequestWriteReceipt;
      try {
        controller.signal.throwIfAborted();
        await this.#availability(true, controller.signal);
        const credential = await this.#credential(request.accountId, controller.signal);
        const pr = request.pullRequest;
        if (credential.account.hostname.toLowerCase() !== pr.hostname.toLowerCase())
          throw new PullRequestReadError("ACCOUNT_CHANGED", "The selected GitHub account does not own this hostname.");
        if (["review_comment", "approve", "request_changes", "inline_comment"].includes(request.action)) {
        const head = await this.#api(credential, { query: HEAD_QUERY, owner: pr.owner, repo: pr.repository, number: pr.number }, controller.signal);
        const data = record(head.data);
        if (text(record(data.viewer).login).toLowerCase() !== credential.account.login.toLowerCase())
          throw new PullRequestReadError("ACCOUNT_CHANGED", "The selected GitHub account changed.");
        if (text(record(record(data.repository).pullRequest).headRefOid) !== request.expectedHeadOid)
          throw new PullRequestReadError("HEAD_CHANGED", "The pull request changed. Refresh and review it before submitting.");
        }
        let url: unknown;
        if (request.target) {
          const node = await this.#api(credential, { query: DISCUSSION_NODE_QUERY, id: request.target.id }, controller.signal);
          const mutation = discussionMutation(request, node, credential.account.login);
          controller.signal.throwIfAborted();
          dispatched = true;
          url = mutation.confirm(await this.#api(credential, mutation.payload, controller.signal, "graphql", 512 * 1024));
        } else if (request.inline) {
          const files: unknown[] = [];
          for (let page = 1; page <= 60; page++) {
            const batch = await this.#restArray(credential, `repos/${pr.owner}/${pr.repository}/pulls/${pr.number}/files?per_page=50&page=${page}`, controller.signal);
            files.push(...batch);
            if (batch.length < 50) break;
            if (page === 60) throw new Error("The changed-file list is truncated.");
          }
          validateInlinePatch(request.inline, files);
          const finish = record((await this.#api(credential, { query: HEAD_QUERY, owner: pr.owner, repo: pr.repository, number: pr.number }, controller.signal)).data);
          this.#viewer(finish, credential);
          if (record(record(finish.repository).pullRequest).headRefOid !== request.expectedHeadOid) throw new PullRequestReadError("HEAD_CHANGED", "The pull request changed. Refresh its diff before commenting.");
          const selection = request.inline;
          const payload = { body: request.body, commit_id: request.expectedHeadOid, path: selection.path, side: selection.side, line: selection.line,
            ...(selection.startLine !== undefined ? { start_line: selection.startLine, start_side: selection.startSide } : {}) };
          controller.signal.throwIfAborted(); dispatched = true;
          const result = await this.#api(credential, payload, controller.signal, `repos/${pr.owner}/${pr.repository}/pulls/${pr.number}/comments`, 512 * 1024);
          if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0 || result.commit_id !== request.expectedHeadOid ||
            result.path !== selection.path || result.side !== selection.side || result.line !== selection.line ||
            (selection.startLine !== undefined && (result.start_line !== selection.startLine || result.start_side !== selection.startSide)) ||
            text(record(result.user).login).toLowerCase() !== credential.account.login.toLowerCase()) throw new Error("GitHub did not confirm the original inline comment.");
          url = result.html_url;
        } else {
          const event = request.action === "approve" ? "APPROVE" : request.action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
          const payload = request.action === "comment" ? { body: request.body } : { body: request.body, event, commit_id: request.expectedHeadOid };
          const endpoint = `repos/${pr.owner}/${pr.repository}/${request.action === "comment" ? "issues" : "pulls"}/${pr.number}/${request.action === "comment" ? "comments" : "reviews"}`;
          controller.signal.throwIfAborted(); dispatched = true;
          const result = await this.#api(credential, payload, controller.signal, endpoint, 512 * 1024);
          const expectedState = event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
          if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0 ||
            text(record(result.user).login).toLowerCase() !== credential.account.login.toLowerCase() ||
            (request.action !== "comment" && (result.commit_id !== request.expectedHeadOid || result.state !== expectedState))) throw new Error("GitHub did not return an exact submission confirmation.");
          url = result.html_url;
        }
        receipt = parsePullRequestWriteReceipt({ hostId: this.#hostId, request, outcome: "succeeded", message: "Submitted to GitHub.", url }, this.#hostId, request);
      } catch (error) {
        receipt = { hostId: this.#hostId, request, outcome: dispatched ? "unknown" : "failed", url: null,
          message: dispatched ? "GitHub may have received this submission. Inspect the original pull request before starting another attempt."
            : error instanceof PullRequestReadError || error instanceof PullRequestDiscussionError ? error.message : "The submission stopped before contacting GitHub. Your text is preserved." };
      }
      try { return records.finish(request, receipt); }
      catch (error) { this.#writeFailures.push(error); throw error; }
    });
    const settled = operation.then(() => {}, () => {});
    this.#submissions.set(request.requestId, operation);
    this.#writeTails.set(target, settled);
    this.#pending.set(controller, settled);
    try { return parsePullRequestWriteReceipt(await operation, this.#hostId, request); }
    finally {
      this.#pending.delete(controller);
      this.#submissions.delete(request.requestId);
      if (this.#writeTails.get(target) === settled) this.#writeTails.delete(target);
    }
  }
  async #executable() {
    const path =
      this.#configuredPath ??
      this.#baseEnv.PATH?.split(delimiter)
        .map((directory) => join(directory, "gh"))
        .find((candidate) => Bun.file(candidate).size > 0);
    if (!path) return null;
    try {
      const resolved = await realpath(path);
      const info = await stat(resolved);
      if (!info.isFile()) return null;
      const identity = `${resolved}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (this.#pathIdentity !== null && this.#pathIdentity !== identity)
        throw new PullRequestReadError(
          "GH_CHANGED",
          "GitHub CLI changed while the host was running.",
        );
      this.#path = resolved;
      this.#pathIdentity = identity;
      return resolved;
    } catch (error) {
      if (error instanceof PullRequestReadError) throw error;
      return null;
    }
  }
  #plainEnv() {
    const env: { [key: string]: string | undefined } = {
      ...this.#baseEnv,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
    };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    return env;
  }
  async #run(args: string[], options: GhRunOptions = {}) {
    const executable = await this.#executable();
    if (!executable)
      throw new PullRequestReadError(
        "GH_MISSING",
        "GitHub CLI is not installed.",
      );
    let result: GhRunResult;
    try {
      result = await this.#runner(executable, args, {
        ...options,
        env: options.env ?? this.#plainEnv(),
      });
    } catch (error) {
      if (options.signal?.aborted)
        throw (
          options.signal.reason ?? new DOMException("Aborted", "AbortError")
        );
      if (error instanceof PullRequestReadError) throw error;
      throw new PullRequestReadError(
        "COMMAND_FAILED",
        "GitHub CLI could not start or complete this read.",
      );
    }
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (result.timedOut)
      throw new PullRequestReadError(
        "TIMED_OUT",
        "GitHub did not respond before the request timed out.",
      );
    if (result.overflow)
      throw new PullRequestReadError(
        "TOO_LARGE",
        "GitHub returned more data than this app can safely read.",
      );
    return result;
  }
  #failure(result: GhRunResult, fallback = "GITHUB_READ_FAILED") {
    const stderr = result.stderr.toLowerCase();
    if (
      /could not resolve|network is unreachable|connection (?:refused|reset)|failed to connect|no route to host|temporary failure in name resolution/.test(
        stderr,
      )
    )
      return new PullRequestReadError(
        "OFFLINE",
        "GitHub is unreachable from this host.",
      );
    if (/rate.?limit|secondary rate/.test(stderr))
      return new PullRequestReadError(
        "RATE_LIMITED",
        "GitHub rate limited this request. Try again later.",
      );
    if (/not logged|authentication|bad credentials|http 401/.test(stderr))
      return new PullRequestReadError(
        "AUTH_REQUIRED",
        "The selected GitHub account needs authentication.",
      );
    return new PullRequestReadError(
      fallback,
      "GitHub could not complete this read request.",
    );
  }
  async #availability(
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<PullRequestReadResult> {
    if (!refresh && this.#accounts.length)
      return {
        type: "accounts",
        availability: {
          status: "ready",
          accounts: this.#accounts,
          activeAccountId:
            this.#activeAccountId ?? this.#accounts[0]?.id ?? null,
          message: null,
        },
      };
    if (!(await this.#executable()))
      return {
        type: "accounts",
        availability: {
          status: "missing",
          accounts: [],
          activeAccountId: null,
          message: "Install GitHub CLI to view pull requests.",
        },
      };
    const result = await this.#run(["auth", "status", "--json", "hosts"], {
      signal,
      stdoutLimit: 512 * 1024,
    });
    if (result.exitCode !== 0) {
      const failure = this.#failure(result);
      return {
        type: "accounts",
        availability: {
          status: failure.code === "OFFLINE" ? "offline" : "unavailable",
          accounts: [],
          activeAccountId: null,
          message:
            failure.code === "OFFLINE"
              ? failure.message
              : "GitHub account status is unavailable.",
        },
      };
    }
    const hosts = record(json(result.stdout).hosts),
      accounts: PullRequestAccount[] = [];
    let active: string | null = null;
    for (const [hostname, value] of Object.entries(hosts)) {
      for (const raw of list(value)) {
        const item = record(raw),
          login = text(item.login);
        if (!login || item.state !== "success") continue;
        const id = createHash("sha256")
          .update(
            `${this.#hostId}\0${this.#pathIdentity}\0${hostname.toLowerCase()}\0${login.toLowerCase()}`,
          )
          .digest("hex");
        const account = { id, hostname, login, name: null, avatarUrl: null };
        accounts.push(account);
        if (item.active === true) active = id;
      }
    }
    this.#accounts = accounts;
    this.#activeAccountId = active ?? accounts[0]?.id ?? null;
    return {
      type: "accounts",
      availability: {
        status: accounts.length ? "ready" : "unauthenticated",
        accounts,
        activeAccountId: this.#activeAccountId,
        message: accounts.length
          ? null
          : "Sign in with GitHub CLI to view pull requests.",
      },
    };
  }
  async #credential(
    accountId: string,
    signal: AbortSignal,
  ): Promise<Credential> {
    if (!this.#accounts.some((item) => item.id === accountId))
      await this.#availability(true, signal);
    const selected = this.#accounts.find((item) => item.id === accountId);
    if (!selected)
      throw new PullRequestReadError(
        "ACCOUNT_CHANGED",
        "The selected GitHub account is no longer available.",
      );
    const tokenResult = await this.#run(
      [
        "auth",
        "token",
        "--hostname",
        selected.hostname,
        "--user",
        selected.login,
      ],
      { signal, stdoutLimit: 64 * 1024 },
    );
    const token = tokenResult.stdout.trim();
    if (tokenResult.exitCode !== 0)
      throw this.#failure(tokenResult, "AUTH_REQUIRED");
    if (!token)
      throw new PullRequestReadError(
        "AUTH_REQUIRED",
        "The selected GitHub account needs authentication.",
      );
    const env = {
      ...this.#plainEnv(),
      GH_TOKEN: token,
      GH_ENTERPRISE_TOKEN: token,
    };
    const userResult = await this.#run(
      ["api", "user", "--hostname", selected.hostname],
      { signal, env, stdoutLimit: 512 * 1024 },
    );
    if (userResult.exitCode !== 0)
      throw this.#failure(userResult, "AUTH_REQUIRED");
    const user = json(userResult.stdout),
      login = text(user.login);
    if (login.toLowerCase() !== selected.login.toLowerCase())
      throw new PullRequestReadError(
        "ACCOUNT_CHANGED",
        "The selected GitHub account changed.",
      );
    const account = {
      ...selected,
      name: typeof user.name === "string" ? user.name : null,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
    };
    this.#accounts = this.#accounts.map((item) =>
      item.id === account.id ? account : item,
    );
    return { account, token, env };
  }
  async #api(
    credential: Credential,
    body: Json,
    signal: AbortSignal,
    endpoint = "graphql",
    stdoutLimit = MAX_STDOUT,
  ) {
    const { query, ...variables } = body;
    const input = endpoint === "graphql" ? { query, variables } : body;
    const result = await this.#run(
      [
        "api",
        endpoint,
        "--hostname",
        credential.account.hostname,
        "--input",
        "-",
      ],
      {
        signal,
        env: credential.env,
        input: JSON.stringify(input),
        stdoutLimit,
      },
    );
    if (result.exitCode !== 0) throw this.#failure(result);
    const payload = json(result.stdout);
    if (Array.isArray(payload.errors) && payload.errors.length)
      throw new PullRequestReadError(
        "GITHUB_READ_FAILED",
        "GitHub could not return the requested data. Refresh or open it on GitHub.",
      );
    return payload;
  }
  async #restArray(
    credential: Credential,
    endpoint: string,
    signal: AbortSignal,
  ) {
    const result = await this.#run(
      ["api", endpoint, "--hostname", credential.account.hostname],
      { signal, env: credential.env, stdoutLimit: MAX_STDOUT },
    );
    if (result.exitCode !== 0) throw this.#failure(result);
    try {
      const value = JSON.parse(result.stdout);
      if (!Array.isArray(value)) throw 0;
      return Array.from({ length: value.length }, (_, index) => value[index]);
    } catch {
      throw new PullRequestReadError(
        "INVALID_RESPONSE",
        "GitHub returned an invalid response.",
      );
    }
  }
  #search(
    filters: PullRequestInboxRequest["filters"],
    relationship: PullRequestRelationship,
  ) {
    const raw = filters.rawQuery?.trim() ?? "",
      qualifiers = pullRequestQualifierNames(raw),
      terms = [
        "is:pr",
        ...(qualifiers.has("archived") ? [] : ["archived:false"]),
      ];
    if (relationship === "authored") terms.push("author:@me");
    else if (relationship === "reviewed") terms.push("reviewed-by:@me");
    else if (relationship === "user_review_requested")
      terms.push("user-review-requested:@me");
    else if (relationship === "team_review_requested")
      terms.push("review-requested:@me");
    const unquoted = raw.replaceAll(/"(?:\\.|[^"\\])*(?:"|$)/gu, "");
    const explicitLifecycle =
      ["closed", "draft", "merged", "state"].some((name) =>
        qualifiers.has(name),
      ) ||
      /(?:^|[\s(])-?is:(?:open|closed|draft|merged|unmerged)(?:\s|$|\))/iu.test(
        unquoted,
      );
    const lifecycle =
      filters.view === "reviewing" && !explicitLifecycle
        ? "open"
        : filters.lifecycle;
    if (lifecycle === "open") terms.push("is:open");
    else if (lifecycle === "merged") terms.push("is:merged");
    else if (lifecycle === "closed") terms.push("is:closed", "is:unmerged");
    if (filters.repository)
      terms.push(
        `repo:${filters.repository.owner}/${filters.repository.repository}`,
      );
    if (raw) terms.push(raw);
    else {
      const query = filters.search.replaceAll(/\s+/g, " ").trim();
      if (query)
        terms.push(
          `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
        );
    }
    if (!qualifiers.has("sort")) terms.push("sort:updated-desc");
    return terms.join(" ");
  }
  #summary(node: Json, account: PullRequestAccount): PullRequestSummary | null {
    const repository = record(node.repository),
      owner = record(repository.owner);
    if (
      !text(node.id) ||
      !text(repository.name) ||
      !text(owner.login) ||
      !Number.isSafeInteger(node.number)
    )
      return null;
    return {
      nodeId: text(node.id),
      pullRequest: {
        hostname: account.hostname,
        owner: text(owner.login),
        repository: text(repository.name),
        number: node.number as number,
      },
      url: text(node.url),
      title: text(node.title),
      author: actor(node.author),
      state: state(node.state),
      isDraft: node.isDraft === true,
      createdAt: iso(node.createdAt),
      updatedAt: iso(node.updatedAt),
      baseBranch: text(node.baseRefName),
      headBranch: text(node.headRefName),
      headOid: text(node.headRefOid),
      additions: integer(node.additions),
      deletions: integer(node.deletions),
      reviewDecision: decision(node.reviewDecision),
    };
  }
  async #section(
    request: PullRequestInboxRequest,
    key: PullRequestRelationship,
    credential: Credential,
    signal: AbortSignal,
  ): Promise<PullRequestInboxSection> {
    try {
      const variables: { [key: string]: unknown } = {
        query: INBOX_QUERY,
        searchQuery: this.#search(request.filters, key),
        first: 50,
      };
      const after = request.after?.[key];
      if (after)
        variables.after = decodeInboxCursor(
          after,
          request.accountId,
          request.filters,
          key,
        );
      const payload = await this.#api(credential, variables, signal);
      const data = record(payload.data);
      if (
        text(record(data.viewer).login).toLowerCase() !==
        credential.account.login.toLowerCase()
      )
        throw new PullRequestReadError(
          "ACCOUNT_CHANGED",
          "The selected GitHub account changed.",
        );
      const search = record(data.search),
        mapped = list(search.nodes)
          .map((item) => ({
            raw: record(item),
            summary: this.#summary(record(item), credential.account),
          }))
          .filter(
            (item): item is { raw: Json; summary: PullRequestSummary } =>
              item.summary !== null,
          );
      const items = mapped.map((item) => item.summary);
      const info = page(search, items.length);
      return {
        key,
        items,
        pageInfo: {
          ...info,
          endCursor:
            info.endCursor === null
              ? null
              : encodeInboxCursor(
                  request.accountId,
                  request.filters,
                  key,
                  info.endCursor,
                ),
        },
        error: null,
      };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof PullRequestReadError &&
          ["ACCOUNT_CHANGED", "GH_CHANGED"].includes(error.code))
      )
        throw error;
      return {
        key,
        items: [],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
          totalCount: 0,
          truncated: false,
        },
        error:
          error instanceof PullRequestReadError
            ? error.message
            : "GitHub could not load this section.",
      };
    }
  }
  async #inbox(
    request: PullRequestInboxRequest,
    signal: AbortSignal,
  ): Promise<PullRequestInboxResult> {
    const credential = await this.#credential(request.accountId, signal);
    const allKeys: PullRequestRelationship[] = hasRelationshipQualifier(
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
    const keys =
      request.after && Object.keys(request.after).length
        ? allKeys.filter((key) => request.after?.[key] !== undefined)
        : allKeys;
    const sections = await Promise.all(
      keys.map((key) => this.#section(request, key, credential, signal)),
    );
    await this.#executable();
    return {
      type: "inbox",
      account: credential.account,
      filters: request.filters,
      sections,
    };
  }
  async #detail(
    request: PullRequestDetailRequest,
    signal: AbortSignal,
  ): Promise<PullRequestDetailResult> {
    const credential = await this.#credential(request.accountId, signal);
    if (
      request.pullRequest.hostname.toLowerCase() !==
      credential.account.hostname.toLowerCase()
    )
      throw new PullRequestReadError(
        "ACCOUNT_CHANGED",
        "The pull request does not belong to the selected GitHub account.",
      );
    const discussionCursor = decodeDiscussionCursor(
        request.after?.discussion,
        request.expectedRevision,
      ),
      checksCursor = decodeCursor(
        request.after?.checks,
        "checks",
        request.expectedRevision,
      ),
      fileCursor = decodeCursor(
        request.after?.files,
        "files",
        request.expectedRevision,
      );
    const variables: Json = {
      query: DETAIL_QUERY,
      owner: request.pullRequest.owner,
      repo: request.pullRequest.repository,
      number: request.pullRequest.number,
      ...(discussionCursor?.value
        ? {
            [discussionCursor.source === "reviewThreads"
              ? "threadsAfter"
              : `${discussionCursor.source}After`]: discussionCursor.value,
          }
        : {}),
      ...(discussionCursor?.threadCommentsAfter
        ? { threadCommentsAfter: discussionCursor.threadCommentsAfter }
        : {}),
      ...(checksCursor ? { checksAfter: checksCursor.value } : {}),
    };
    const payload = await this.#api(credential, variables, signal);
    const data = record(payload.data);
    this.#viewer(data, credential);
    const pr = record(record(data.repository).pullRequest);
    if (!Object.keys(pr).length)
      throw new PullRequestReadError(
        "NOT_FOUND",
        "The pull request was not found.",
      );
    const summary = this.#summary(
      {
        ...pr,
        repository: {
          name: request.pullRequest.repository,
          owner: { login: request.pullRequest.owner },
        },
      },
      credential.account,
    );
    if (!summary)
      throw new PullRequestReadError(
        "INVALID_RESPONSE",
        "GitHub returned incomplete pull request metadata.",
      );
    const revision = revisionFor(
      credential.account.id,
      request.pullRequest,
      text(pr.headRefOid),
      text(pr.baseRefOid),
      text(pr.updatedAt),
    );
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== revision
    )
      throw new PullRequestReadError(
        "HEAD_CHANGED",
        "The pull request changed. Refresh before continuing.",
      );
    const source = discussionCursor?.source ?? "comments",
      connection = record(pr[source]);
    if (
      discussionCursor?.threadId &&
      text(record(list(connection.nodes)[0]).id) !== discussionCursor.threadId
    )
      throw new PullRequestReadError(
        "HEAD_CHANGED",
        "The review thread changed. Refresh before continuing.",
      );
    const discussionItems: PullRequestDiscussionItem[] =
      source === "comments"
        ? list(connection.nodes).map((item) => {
            const c = record(item);
            return {
              id: text(c.id) || `comment:${text(c.url)}`,
              kind: "comment" as const,
              author: actor(c.author),
              body: text(c.body),
              canUpdate: c.viewerCanUpdate === true, canDelete: c.viewerCanDelete === true,
              createdAt: iso(c.createdAt),
              url: typeof c.url === "string" ? c.url : null,
              path: null,
              line: null,
              resolved: null,
            };
          })
        : source === "reviews"
          ? list(connection.nodes).map((item) => {
              const c = record(item);
              return {
                id: text(c.id) || `review:${text(c.url)}`,
                kind: "review" as const,
                author: actor(c.author),
                body: text(c.body),
              canUpdate: c.viewerCanUpdate === true, canDelete: c.viewerCanDelete === true,
                createdAt: iso(c.submittedAt ?? c.createdAt),
                url: typeof c.url === "string" ? c.url : null,
                path: null,
                line: null,
                resolved: null,
              };
            })
          : list(connection.nodes).flatMap((item) => {
              const thread = record(item);
              return list(record(thread.comments).nodes).map((comment) => {
                const c = record(comment);
                return {
                  id: text(c.id) || `review-comment:${text(c.url)}`,
                  kind: "review_comment" as const,
                  author: actor(c.author),
                  body: text(c.body),
              canUpdate: c.viewerCanUpdate === true, canDelete: c.viewerCanDelete === true,
                  createdAt: iso(c.createdAt),
                  url: typeof c.url === "string" ? c.url : null,
                  path: typeof thread.path === "string" ? thread.path : null,
                  line:
                    typeof thread.line === "number"
                      ? thread.line
                      : typeof thread.originalLine === "number"
                        ? thread.originalLine
                        : null,
                  resolved: thread.isResolved === true,
                  thread: { id: text(thread.id), side: thread.diffSide === "LEFT" || thread.diffSide === "RIGHT" ? thread.diffSide : null,
                    startSide: thread.startDiffSide === "LEFT" || thread.startDiffSide === "RIGHT" ? thread.startDiffSide : null,
                    startLine: typeof thread.startLine === "number" ? thread.startLine : null,
                    originalLine: typeof thread.originalLine === "number" ? thread.originalLine : null,
                    originalStartLine: typeof thread.originalStartLine === "number" ? thread.originalStartLine : null,
                    canReply: thread.viewerCanReply === true, canResolve: thread.viewerCanResolve === true, canUnresolve: thread.viewerCanUnresolve === true },
                };
              });
            });
    const checkConnection = record(
      record(list(record(pr.commits).nodes).at(-1)).commit,
    );
    const checks = record(record(checkConnection.statusCheckRollup).contexts),
      checkItems = list(checks.nodes).map((item, index) => check(record(item)));
    const fileArray = await this.#restArray(
      credential,
      `repos/${request.pullRequest.owner}/${request.pullRequest.repository}/pulls/${request.pullRequest.number}/files?per_page=50&page=${fileCursor?.page ?? 1}`,
      signal,
    );
    const files = fileArray.map((item) => file(record(item)));
    const fileTotal = integer(pr.changedFiles),
      currentFilePage = fileCursor?.page ?? 1;
    const fileHasNext =
        files.length === 50 &&
        currentFilePage < 60 &&
        (fileTotal === 0 || currentFilePage * 50 < fileTotal),
      nextFile = fileHasNext
        ? encodeCursor("files", { page: (fileCursor?.page ?? 1) + 1, revision })
        : null;
    const discussionPage =
      source === "reviewThreads"
        ? nextThreadPage(
            connection,
            discussionCursor,
            discussionItems.length,
            revision,
          )
        : nextDiscussionPage(
            source,
            connection,
            discussionItems.length,
            revision,
          );
    const result: PullRequestDetailResult = {
      type: "detail",
      account: credential.account,
      revision,
      summary,
      body: text(pr.body),
      discussion: {
        items: discussionItems,
        pageInfo: discussionPage,
      },
      checks: {
        items: checkItems,
        pageInfo: graphqlPage(checks, checkItems.length, "checks", revision),
      },
      files: {
        items: files,
        pageInfo: {
          hasNextPage: fileHasNext,
          endCursor: nextFile,
          totalCount: fileTotal || files.length,
          truncated: !fileHasNext && fileTotal > currentFilePage * 50,
        },
      },
    };
    const finish = await this.#api(
      credential,
      {
        query: HEAD_QUERY,
        owner: request.pullRequest.owner,
        repo: request.pullRequest.repository,
        number: request.pullRequest.number,
      },
      signal,
    );
    const finishData = record(finish.data);
    this.#viewer(finishData, credential);
    const finalPr = record(record(finishData.repository).pullRequest);
    if (
      revisionFor(
        credential.account.id,
        request.pullRequest,
        text(finalPr.headRefOid),
        text(finalPr.baseRefOid),
        text(finalPr.updatedAt),
      ) !== revision
    )
      throw new PullRequestReadError(
        "HEAD_CHANGED",
        "The pull request changed while it was loading.",
      );
    await this.#executable();
    return result;
  }
  #viewer(data: Json, credential: Credential) {
    if (
      text(record(data.viewer).login).toLowerCase() !==
      credential.account.login.toLowerCase()
    )
      throw new PullRequestReadError(
        "ACCOUNT_CHANGED",
        "The selected GitHub account changed.",
      );
  }
}

function revisionFor(
  accountId: string,
  identity: PullRequestDetailRequest["pullRequest"],
  head: string,
  base: string,
  updated: string,
) {
  return createHash("sha256")
    .update(JSON.stringify([accountId, identity, head, base, updated]))
    .digest("hex");
}
function encodeCursor(kind: string, value: Json) {
  return Buffer.from(JSON.stringify({ kind, ...value }), "utf8").toString(
    "base64url",
  );
}
function decodeCursor(
  value: string | undefined,
  kind: string,
  expectedRevision?: string,
): { value?: string; page?: number } | null {
  if (value === undefined) return null;
  try {
    const parsed = record(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.kind !== kind || parsed.revision !== expectedRevision) throw 0;
    if (typeof parsed.value === "string") return { value: parsed.value };
    if (
      typeof parsed.page === "number" &&
      Number.isSafeInteger(parsed.page) &&
      parsed.page > 0
    )
      return { page: parsed.page };
    throw 0;
  } catch {
    throw new PullRequestReadError(
      "INVALID_CURSOR",
      "The pull request cursor is invalid.",
    );
  }
}
interface DiscussionCursor {
  source: "comments" | "reviews" | "reviewThreads";
  value?: string;
  threadId?: string;
  threadCommentsAfter?: string;
}
function decodeDiscussionCursor(
  value: string | undefined,
  expectedRevision?: string,
): DiscussionCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = record(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.kind !== "discussion" ||
      parsed.revision !== expectedRevision ||
      !["comments", "reviews", "reviewThreads"].includes(text(parsed.source))
    )
      throw 0;
    if (
      parsed.value !== undefined &&
      (typeof parsed.value !== "string" || !parsed.value)
    )
      throw 0;
    const nested =
      parsed.threadId !== undefined || parsed.threadCommentsAfter !== undefined;
    if (
      nested &&
      (parsed.source !== "reviewThreads" ||
        typeof parsed.threadId !== "string" ||
        !parsed.threadId ||
        typeof parsed.threadCommentsAfter !== "string" ||
        !parsed.threadCommentsAfter)
    )
      throw 0;
    return {
      source: parsed.source as "comments" | "reviews" | "reviewThreads",
      ...(typeof parsed.value === "string" ? { value: parsed.value } : {}),
      ...(nested
        ? {
            threadId: parsed.threadId as string,
            threadCommentsAfter: parsed.threadCommentsAfter as string,
          }
        : {}),
    };
  } catch {
    throw new PullRequestReadError(
      "INVALID_CURSOR",
      "The pull request cursor is invalid.",
    );
  }
}
// Page a single thread at a time so a long thread remains resumable without
// retaining a server-side queue or trusting a caller-supplied foreign node ID.
function nextThreadPage(
  connection: Json,
  cursor: DiscussionCursor | null,
  count: number,
  revision: string,
) {
  const thread = record(list(connection.nodes)[0]);
  const comments = page(record(thread.comments), count);
  if (comments.hasNextPage) {
    const threadId = text(thread.id);
    if (!threadId || comments.endCursor === cursor?.threadCommentsAfter)
      throw new PullRequestReadError(
        "INVALID_RESPONSE",
        "GitHub returned an invalid review comment continuation.",
      );
    return {
      ...comments,
      endCursor: encodeCursor("discussion", {
        source: "reviewThreads",
        ...(cursor?.value ? { value: cursor.value } : {}),
        threadId,
        threadCommentsAfter: comments.endCursor,
        revision,
      }),
    };
  }
  const next = nextDiscussionPage("reviewThreads", connection, count, revision);
  if (next.hasNextPage && page(connection, count).endCursor === cursor?.value)
    throw new PullRequestReadError(
      "INVALID_RESPONSE",
      "GitHub repeated a review thread continuation.",
    );
  return { ...next, truncated: next.truncated || comments.truncated };
}
function graphqlPage(
  connection: Json,
  count: number,
  kind: string,
  revision: string,
) {
  const p = page(connection, count);
  return {
    ...p,
    endCursor:
      p.endCursor === null
        ? null
        : encodeCursor(kind, { value: p.endCursor, revision }),
  };
}
function nextDiscussionPage(
  source: "comments" | "reviews" | "reviewThreads",
  connection: Json,
  count: number,
  revision: string,
) {
  const current = page(connection, count);
  if (current.hasNextPage)
    return {
      ...current,
      endCursor: encodeCursor("discussion", {
        source,
        value: current.endCursor,
        revision,
      }),
    };
  const next =
    source === "comments"
      ? "reviews"
      : source === "reviews"
        ? "reviewThreads"
        : null;
  if (next !== null)
    return {
      hasNextPage: true,
      endCursor: encodeCursor("discussion", { source: next, revision }),
      totalCount: count,
      truncated: current.truncated,
    };
  return { ...current, endCursor: null };
}
function encodeInboxCursor(
  accountId: string,
  filters: PullRequestInboxRequest["filters"],
  key: PullRequestRelationship,
  value: string,
) {
  return Buffer.from(
    JSON.stringify({ accountId, filters, key, value }),
    "utf8",
  ).toString("base64url");
}
function decodeInboxCursor(
  value: string,
  accountId: string,
  filters: PullRequestInboxRequest["filters"],
  key: PullRequestRelationship,
) {
  try {
    const parsed = record(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.accountId !== accountId ||
      parsed.key !== key ||
      JSON.stringify(parsed.filters) !== JSON.stringify(filters) ||
      typeof parsed.value !== "string"
    )
      throw 0;
    return parsed.value;
  } catch {
    throw new PullRequestReadError(
      "INVALID_CURSOR",
      "The pull request cursor is invalid.",
    );
  }
}
function check(value: Json) {
  if (!text(value.id))
    throw new PullRequestReadError(
      "INVALID_RESPONSE",
      "GitHub returned a check without its original ID.",
    );
  const type = value.__typename;
  if (type === "StatusContext") {
    const state = text(value.state);
    return {
      id: text(value.id),
      name: text(value.context),
      workflow: null,
      state,
      bucket:
        state === "SUCCESS"
          ? ("pass" as const)
          : ["ERROR", "FAILURE"].includes(state)
            ? ("fail" as const)
            : state === "PENDING"
              ? ("pending" as const)
              : ("unknown" as const),
      startedAt: typeof value.createdAt === "string" ? value.createdAt : null,
      completedAt: null,
      url: typeof value.targetUrl === "string" ? value.targetUrl : null,
    };
  }
  const status = text(value.status),
    conclusion = text(value.conclusion),
    bucket =
      status !== "COMPLETED"
        ? ("pending" as const)
        : conclusion === "SUCCESS"
          ? ("pass" as const)
          : [
                "FAILURE",
                "STARTUP_FAILURE",
                "TIMED_OUT",
                "ACTION_REQUIRED",
              ].includes(conclusion)
            ? ("fail" as const)
            : conclusion === "CANCELLED"
              ? ("cancel" as const)
              : ["SKIPPED", "NEUTRAL"].includes(conclusion)
                ? ("skip" as const)
                : ("unknown" as const);
  return {
    id: text(value.id),
    name: text(value.name),
    workflow:
      typeof record(record(record(value.checkSuite).workflowRun).workflow)
        .name === "string"
        ? text(
            record(record(record(value.checkSuite).workflowRun).workflow).name,
          )
        : null,
    state: conclusion || status,
    bucket,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    completedAt:
      typeof value.completedAt === "string" ? value.completedAt : null,
    url: typeof value.detailsUrl === "string" ? value.detailsUrl : null,
  };
}
function file(value: Json) {
  const patch =
    typeof value.patch !== "string"
      ? { unavailableReason: "not_returned" as const }
      : value.patch.length > 256 * 1024
        ? { unavailableReason: "too_large" as const }
        : { text: value.patch };
  return {
    path: text(value.filename),
    previousPath:
      typeof value.previous_filename === "string"
        ? value.previous_filename
        : null,
    status: text(value.status),
    additions: integer(value.additions),
    deletions: integer(value.deletions),
    changes: integer(value.changes),
    blobOid: text(value.sha),
    patch,
  };
}
