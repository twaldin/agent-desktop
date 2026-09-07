import { afterAll, describe, expect, test } from "bun:test";
import type { NativeMarketplaceCatalog, NativePluginAcquisitionReceipt } from "@agent-desktop/shared";
import {
  closePluginAcquisitionRequest,
  requestMarketplaceCatalog,
  requestPluginAcquisitionOperations,
  reviewPluginAcquisition,
  startPluginAcquisition,
} from "./plugin-acquisition-transport";

const id = "12345678-1234-4234-8234-123456789abc";
const target = { projectId: "project-a" } as const;
const baseReceipt: NativePluginAcquisitionReceipt = {
  id, operation: "plugin.install", target, state: "running", createdAt: 10, updatedAt: 10,
};
const seen: Array<{ path: string; authorization: string | null; cache: string | null; body: unknown }> = [];
const catalog: NativeMarketplaceCatalog = {
  revision: "catalog-revision", projectScopeAvailable: true,
  marketplaces: [{ name: "local", sourceType: "git", sourceOptions: {ref:"selected",sparsePaths:["plugins/a"]}, catalogAvailable: true, plugins: [{ name: "sample", installable: true }] }],
  installed: [],
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url); const body = await request.json().catch(() => undefined);
  seen.push({ path: url.pathname, authorization: request.headers.get("authorization"), cache: request.headers.get("cache-control"), body });
  if (url.pathname.startsWith("/invalid-start/")) return new Response("not json", { status: 202 });
  if (url.pathname.startsWith("/rejected-start/")) return Response.json({ error: "The request was rejected." }, { status: 400 });
  if (url.pathname.startsWith("/wrong-target/")) return Response.json({ ...baseReceipt, target: { projectId: "project-b" } }, { status: 202 });
  if (url.pathname.endsWith("/catalog")) return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
  if (url.pathname.endsWith("/operations")) return Response.json([baseReceipt]);
  if (url.pathname.endsWith("/review")) return Response.json({ ...baseReceipt, state: "reviewed", updatedAt: 11 });
  if (url.pathname.endsWith("/close-request")) return Response.json({ ...baseReceipt, operation: (body as any)?.operation ?? baseReceipt.operation, state: "reviewed", updatedAt: 11 });
  return Response.json({...baseReceipt,operation:(body as any)?.request?.action?.operation??baseReceipt.operation}, { status: 202 });
} });
const endpoint = (prefix = "ok") => ({ origin: `http://127.0.0.1:${server.port}/${prefix}`, hostId: "host-a", token: "transport-token" });
afterAll(() => server.stop(true));

describe("plugin acquisition desktop transport", () => {
  test("forwards the exact target, caller identity, and private host credentials", async () => {
    expect(await requestMarketplaceCatalog(endpoint(), target)).toEqual(catalog);
    const request = { id, expectedRevision: "catalog-revision", action: {
      operation: "plugin.install" as const, name: "sample", marketplace: "local", scope: "project" as const,
    } };
    expect(await startPluginAcquisition(endpoint(), target, request)).toEqual(baseReceipt);
    expect(seen.at(-1)).toEqual({
      path: "/ok/v1/integrations/acquisition/start", authorization: "Bearer transport-token", cache: "no-store",
      body: { target, request },
    });
    expect(JSON.stringify(seen.at(-1)?.body)).not.toContain("transport-token");
  });

  test("forwards complete source options without dropping or moving them into the source URL",async()=>{
    const request={id,expectedRevision:'catalog-revision',action:{operation:'marketplace.add' as const,source:'https://fixture.invalid/repo',sourceOptions:{ref:'release/x',sparsePaths:['plugins/a','literal[1].txt']}}};
    expect(await startPluginAcquisition(endpoint(),target,request)).toMatchObject({id,operation:'marketplace.add'});expect(seen.at(-1)?.body).toEqual({target,request});
  });

  test("preserves the exact scoped upgrade identity in requests and receipts", async () => {
    const request={id,expectedRevision:'catalog-revision',action:{operation:'plugin.upgrade' as const,pluginId:'sample@local',scope:'project' as const}};
    expect(await startPluginAcquisition(endpoint(),target,request)).toMatchObject({id,operation:'plugin.upgrade'});
    expect(seen.at(-1)?.body).toEqual({target,request});
    expect(await closePluginAcquisitionRequest(endpoint(),target,{id,operation:'plugin.upgrade'})).toMatchObject({id,operation:'plugin.upgrade'});
    expect(seen.at(-1)?.body).toEqual({target,id,operation:'plugin.upgrade'});
  });

  test("reads host-wide operations and reviews or closes only the exact target and identity", async () => {
    expect(await requestPluginAcquisitionOperations(endpoint())).toEqual([baseReceipt]);
    expect(seen.at(-1)?.body).toEqual({});
    expect(await reviewPluginAcquisition(endpoint(), target, id, "catalog-revision")).toMatchObject({ id, state: "reviewed", target });
    expect(seen.at(-1)?.body).toEqual({ target, id, expectedRevision: "catalog-revision" });
    expect(await closePluginAcquisitionRequest(endpoint(), target, { id, operation: "plugin.install" })).toMatchObject({ id, state: "reviewed", target });
    expect(seen.at(-1)?.body).toEqual({ target, id, operation: "plugin.install" });
  });

  test("classifies invalid or mismatched post-dispatch responses as unknown without retry", async () => {
    const request = { id, expectedRevision: "catalog-revision", action: {
      operation: "plugin.install" as const, name: "sample", marketplace: "local", scope: "project" as const,
    } };
    const before = seen.length;
    await expect(startPluginAcquisition(endpoint("invalid-start"), target, request)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(seen.length).toBe(before + 1);
    await expect(startPluginAcquisition(endpoint("wrong-target"), target, request)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(seen.length).toBe(before + 2);
    await expect(startPluginAcquisition(endpoint("rejected-start"), target, request)).rejects.toEqual(expect.objectContaining({ status: 400, code: "OUTCOME_UNKNOWN" }));
    expect(seen.length).toBe(before + 3);
    await expect(reviewPluginAcquisition(endpoint("invalid-start"), target, id, "catalog-revision")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(seen.length).toBe(before + 4);
  });

  test("does not dispatch malformed caller identities", async () => {
    const before = seen.length;
    await expect(startPluginAcquisition(endpoint(), target, {
      id: "new-id", expectedRevision: "catalog-revision", action: { operation: "marketplace.remove", name: "local" },
    })).rejects.toThrow("Invalid plugin acquisition request");
    expect(seen.length).toBe(before);
  });
});
