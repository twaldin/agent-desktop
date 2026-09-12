import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import type { AutomationMutation } from "../../../packages/shared/src/automations";

const roots: string[] = [], stores: HostStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "automation-records-")); roots.push(root); const store = new HostStore(root); stores.push(store); return { root, store }; };
const save = (requestId = "save") => ({ type: "save", requestId, id: "task", expectedRevision: 0, input: { name: "Daily", prompt: "Do the work",
  rrule: "RRULE:FREQ=DAILY", destination: { kind: "heartbeat", sessionId: "session" }, notificationPolicy: "all", status: "active" } } as const satisfies AutomationMutation);

test("schema 23 is raised only by the first automation record and preserves prior metadata", () => {
  const { store } = fixture(); store.writeMetadata("device-access.v1", { revision: 4, enabled: false, revokedNodeIds: ["node"] });
  expect(store.readMetadata<unknown>("device-access.v1")).toEqual({ revision: 4, enabled: false, revokedNodeIds: ["node"] });
  const mutation = save(); store.automations.claim(mutation); store.automations.save(mutation, mutation.input, 10);
  const version = (store as unknown as { db: import("bun:sqlite").Database }).db.query<{user_version:number},[]>("PRAGMA user_version").get()!.user_version;
  expect(version).toBe(23);
  expect(store.readMetadata<unknown>("device-access.v1")).toEqual({ revision: 4, enabled: false, revokedNodeIds: ["node"] });
});

test("request identity is idempotent and conflicting input is rejected", () => {
  const { store } = fixture(), mutation = save(); store.automations.claim(mutation);
  const done = store.automations.save(mutation, mutation.input, 10);
  expect(store.automations.claim(mutation)).toEqual(done);
  expect(() => store.automations.claim({ ...mutation, input: { ...mutation.input, prompt: "different" } })).toThrow("different input");
});

test("restart marks admitted nonterminal runs unknown without replay", () => {
  const { root, store } = fixture(), mutation = save(); store.automations.claim(mutation); const task = store.automations.save(mutation, mutation.input, 10).task!;
  const runMutation = { type: "run", requestId: "run", id: task.id, expectedRevision: task.revision } as const;
  store.automations.claim(runMutation); const run = store.automations.reserveManual(runMutation, 20).run!;
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new HostStore(root); stores.push(reopened);
  expect(reopened.automations.getRun(run.id)).toMatchObject({ status: "unknown", error: expect.stringContaining("restarted") });
});

test("history read and archive state is durable while admitted run receipts remain intact",()=>{
  const{store}=fixture(),mutation=save();store.automations.claim(mutation);const task=store.automations.save(mutation,mutation.input,10).task!;
  const runMutation={type:"run",requestId:"run",id:task.id,expectedRevision:task.revision}as const;store.automations.claim(runMutation);const run=store.automations.reserveManual(runMutation,20).run!;store.automations.advanceRun(run.id,"completed");
  const archive={type:"history",requestId:"archive",runId:run.id,read:true,archived:true}as const;store.automations.claim(archive);expect(store.automations.history(archive).run).toMatchObject({readAt:expect.any(Number),archivedAt:expect.any(Number)});expect(store.automations.snapshot().runs[0]).toMatchObject({id:run.id,archivedAt:expect.any(Number)});
  const restore={type:"history",requestId:"restore",runId:run.id,read:false,archived:false}as const;store.automations.claim(restore);store.automations.history(restore);expect(store.automations.snapshot().runs[0]).toMatchObject({id:run.id,readAt:null,archivedAt:null,status:"completed"});
});
