import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
type OAuthCredentials = Omit<OAuthCredential, "type">;
import { pickSoonestExpiringCredit } from "@oh-my-pi/pi-ai/usage/openai-codex-reset";

const provider = "openai-codex";
const baseUrl = "https://chatgpt.com";
const tempDirs: string[] = [];
const stores: AuthStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fixtureCredentials(accountId: string, token = `access-${accountId}`): OAuthCredentials {
  return { access: token, refresh: `refresh-${accountId}`, expires: Date.now() + 86_400_000, accountId, email: `${accountId}@fixture.invalid` };
}

async function storage(fetch: typeof globalThis.fetch = Object.assign(async () => { throw new Error("unexpected fixture fetch"); }, { preconnect() {} }) as typeof globalThis.fetch, options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-desktop-usage-native-")); tempDirs.push(dir);
  const auth = await AuthStorage.create(path.join(dir, "auth.db"), { usageFetch: fetch, ...options } as never); stores.push(auth);
  return auth;
}

function usagePayload(accountId: string) {
  return { plan_type: "plus", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } }, rate_limit_reset_credits: { available_count: 0 }, account_id: accountId };
}

function creditsPayload(accountId: string) {
  return { available_count: 2, credits: [{ id: `${accountId}-soon`, status: "available", expires_at: "2099-01-01T00:00:00Z" }, { id: `${accountId}-later`, status: "available", expires_at: "2099-02-01T00:00:00Z" }] };
}

test("native usage reports enumerate every stored row through the controlled usageFetch", async () => {
  const calls: string[] = [];
  let reportCall = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init); const url = new URL(request.url); calls.push(url.pathname);
    if (url.origin !== baseUrl || url.pathname !== "/backend-api/wham/usage") throw new Error("Unexpected controlled usage endpoint");
    const accountId = ["account-a", "account-b"][reportCall++] ?? "unknown";
    return Response.json(usagePayload(accountId));
  }) as typeof globalThis.fetch;
  const auth = await storage(fetch);
  await auth.set(provider, [{ type: "oauth", ...fixtureCredentials("account-a") }, { type: "oauth", ...fixtureCredentials("account-b") }]);
  const reports = await auth.fetchUsageReports({ baseUrlResolver: () => baseUrl });
  expect(reports?.length).toBeGreaterThan(0);
  expect(calls).toHaveLength(2); expect(calls.every(pathname => pathname === "/backend-api/wham/usage")).toBe(true);
});

test("native reset-credit listing keeps every account and reports fixture failures", async () => {
  let creditCall = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input); const url = new URL(request.url);
    expect(url.origin).toBe(baseUrl); expect(url.pathname).toBe("/backend-api/wham/rate-limit-reset-credits");
    const accountId = ["account-a", "account-b"][creditCall++] ?? "unknown";
    if (accountId === "account-b") return new Response("blocked", { status: 503 });
    return Response.json(creditsPayload(accountId));
  }) as typeof globalThis.fetch;
  const auth = await storage(fetch);
  await auth.set(provider, [{ type: "oauth", ...fixtureCredentials("account-a") }, { type: "oauth", ...fixtureCredentials("account-b") }]);
  const rows = await auth.listResetCredits({ baseUrlResolver: () => baseUrl });
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.accountId === "account-a")).toMatchObject({ availableCount: 2 });
  expect(rows.find(row => row.accountId === "account-a")?.credits[0]).toMatchObject({ id: "account-a-soon" });
  expect(rows.find(row => row.accountId === "account-b")).toMatchObject({ availableCount: 0, credits: [], error: "Failed to load saved resets" });
});

test("redeem admission is synchronous after refresh and prevents sibling or rotated identity consumption", async () => {
  let consumeCalls = 0;
  let consumeBody: Record<string, unknown> | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init); const url = new URL(request.url);
    expect(url.origin).toBe(baseUrl); expect(url.pathname).toBe("/backend-api/wham/rate-limit-reset-credits/consume");
    consumeCalls++; consumeBody = JSON.parse(await request.text()); return Response.json({ code: "reset" });
  }) as typeof globalThis.fetch;
  const auth = await storage(fetch, { refreshOAuthCredential: async (_provider: string, _id: number, credentials: OAuthCredentials) => {
    return { ...credentials, access: "access-rotated", accountId: "account-rotated", email: "rotated@fixture.invalid", expires: Date.now() + 86_400_000 };
  } });
  await auth.set(provider, { type: "oauth", ...fixtureCredentials("account-a"), expires: Date.now() - 1 });
  const target = auth.listStoredCredentials(provider)[0]!;
  const pending = auth.redeemResetCredit({ target: { credentialId: target.id }, creditId: "credit-a", redeemRequestId: "fixed-request-id", baseUrlResolver: () => baseUrl, beforeConsume: identity => identity.accountId === "account-a" });
  await expect(pending).resolves.toMatchObject({ ok: false, code: "admission_rejected", accountId: "account-rotated" });
  expect(consumeCalls).toBe(0);

  await auth.set(provider, [{ type: "oauth", ...fixtureCredentials("account-a") }, { type: "oauth", ...fixtureCredentials("account-b") }]);
  const sibling = auth.listStoredCredentials(provider).find(row => row.credential.type === "oauth" && row.credential.accountId === "account-b")!;
  await expect(auth.redeemResetCredit({ target: { credentialId: target.id }, creditId: "credit-a", baseUrlResolver: () => baseUrl, beforeConsume: identity => identity.credentialId === sibling.id })).resolves.toMatchObject({ ok: false, code: "no_account" });
  expect(consumeCalls).toBe(0); expect(consumeBody).toBeUndefined();
});

test("consume outcomes preserve legacy success while requiring explicit modern outcomes and stable IDs", async () => {
  const outcomes: unknown[] = [{}, { code: 7 }, { code: "" }, "{unreadable", {}, { code: "already_redeemed" }, { code: "no_credit" }, { code: "nothing_to_reset" }, { code: "future_code" }];
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init); expect(new URL(request.url).pathname).toBe("/backend-api/wham/rate-limit-reset-credits/consume");
    bodies.push(JSON.parse(await request.text())); const outcome = outcomes.shift(); return typeof outcome === "string" ? new Response(outcome, { status: 200 }) : Response.json(outcome);
  }) as typeof globalThis.fetch;
  const auth = await storage(fetch); await auth.set(provider, { type: "oauth", ...fixtureCredentials("account-a") });
  const id = auth.listStoredCredentials(provider)[0]!.id;
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "outcome_unknown" });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "outcome_unknown" });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "outcome_unknown" });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "outcome_unknown" });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: true, code: "reset" });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "already_redeemed" });
  for (const code of ["no_credit", "nothing_to_reset"]) await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code });
  await expect(auth.redeemResetCredit({ target: { credentialId: id }, creditId: "c", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl })).resolves.toMatchObject({ ok: false, code: "future_code" });
  expect(bodies[4]).toMatchObject({ credit_id: "c", redeem_request_id: expect.any(String) });
});

test("expiry selection favors the soonest available dated credit, then undated, then first fallback", () => {
  expect(pickSoonestExpiringCredit([{ id: "later", expiresAt: "2099-02-01T00:00:00Z" }, { id: "soon", expiresAt: "2099-01-01T00:00:00Z" }])).toMatchObject({ id: "soon" });
  expect(pickSoonestExpiringCredit([{ id: "redeemed", status: "redeemed", expiresAt: "2020-01-01T00:00:00Z" }, { id: "undated" }])).toMatchObject({ id: "undated" });
  expect(pickSoonestExpiringCredit([{ id: "redeemed", status: "redeemed" }])).toMatchObject({ id: "redeemed" });
});

test("actual consume receives one stable ID; false, thrown, and nonboolean final guards fail closed", async () => {
  const bodies: unknown[] = [];
  const auth = await storage((async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(await new Request(input, init).text())); return Response.json({ code: "reset" });
  }) as typeof fetch);
  await auth.set(provider, { type: "oauth", ...fixtureCredentials("account-a") });
  const target = { credentialId: auth.listStoredCredentials(provider)[0]!.id };
  const base = { target, creditId: "exact-credit", redeemRequestId: "stable-original-request", requireExplicitOutcome: true, baseUrlResolver: () => baseUrl };
  for (const beforeConsume of [() => false, () => { throw new Error("fixture-private-error"); }, (() => Promise.resolve(true)) as unknown as () => boolean]) {
    expect(await auth.redeemResetCredit({ ...base, beforeConsume })).toMatchObject({ ok: false, code: "admission_rejected" });
  }
  expect(bodies).toHaveLength(0);
  let identity: unknown;
  expect(await auth.redeemResetCredit({ ...base, beforeConsume: value => { identity = value; return true; } })).toMatchObject({ ok: true, code: "reset", creditId: "exact-credit" });
  expect(identity).toMatchObject({ provider, credentialId: target.credentialId, accountId: "account-a", creditId: "exact-credit" });
  expect(JSON.stringify(identity)).not.toContain("access-");
  expect(bodies).toEqual([{ credit_id: "exact-credit", account_id: "account-a", redeem_request_id: "stable-original-request" }]);
});
