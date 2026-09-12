import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { PreferencesStore } from "./store";
import { parsePreferenceChange } from "../../../../packages/shared/src/preferences";

test("keep-awake preference persists, replicates and respects tombstones without changing access policy", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-keep-awake-"));
  const stores: HostStore[] = [];
  const open = (path: string) => { const store = new HostStore(join(root, path)); stores.push(store); return store; };
  try {
    const first = open("first"), second = open("second"), a = new PreferencesStore(first), b = new PreferencesStore(second);
    const access = first.getDeviceAccessPolicy();
    const key = "connections.keepAwakeWhilePluggedIn";
    expect(a.get(key)).toBeUndefined();
    expect(() => parsePreferenceChange({ key, value: "true" })).toThrow();
    a.put({ key, value: true }); b.merge(a.snapshot());
    expect(b.get(key)).toMatchObject({ deleted: false, value: true });
    expect(new PreferencesStore(open("first")).get(key)).toEqual(a.get(key));
    expect(first.getDeviceAccessPolicy()).toEqual(access);
    const old = a.snapshot(); b.put({ key, deleted: true }); a.merge(b.snapshot()); a.merge(old);
    expect(a.get(key)).toMatchObject({ deleted: true });
    a.put({ key, value: false }); b.merge(a.snapshot());
    expect(b.get(key)).toMatchObject({ deleted: false, value: false });
  } finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});
