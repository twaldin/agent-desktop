import { expect, test } from "bun:test";
import { KeepAwake, type KeepAwakePolicy } from "./keep-awake";

function fixture(supported = true) {
  let battery = false, nextId = 0, failPower = false, failStop = false;
  const active = new Set<number>(), starts: string[] = [], stops: number[] = [];
  let policy: KeepAwakePolicy = { requested: false, remoteAccessEnabled: true };
  let read: () => Promise<KeepAwakePolicy> = async () => ({ ...policy });
  const owner = new KeepAwake({ supported,
    onBattery: () => { if (failPower) throw Error("Power status unavailable"); return battery; },
    start: type => { starts.push(type); active.add(++nextId); return nextId; },
    stop: id => { stops.push(id); if (failStop) return false; return active.delete(id); },
    isStarted: id => active.has(id),
  }, () => read(), () => {});
  return { owner, active, starts, stops, policy, setRead(value: typeof read) { read = value; },
    battery(value: boolean) { battery = value; owner.powerChanged(); },
    failPower(value: boolean) { failPower = value; owner.powerChanged(); },
    failStop(value: boolean) { failStop = value; },
  };
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

test("one process blocker follows committed preference, local access, AC and connection", async () => {
  const f = fixture(); f.owner.connection(true); await settle();
  expect(f.starts).toEqual([]);
  f.policy.requested = true; f.owner.invalidate(); await settle();
  expect(f.starts).toEqual(["prevent-app-suspension"]);
  await f.owner.refresh(); f.owner.powerChanged();
  expect(f.starts).toHaveLength(1);
  f.battery(true); expect(f.active.size).toBe(0);
  f.battery(false); expect(f.active.size).toBe(1);
  f.policy.remoteAccessEnabled = false; f.owner.invalidate();
  expect(f.active.size).toBe(0); await settle(); expect(f.active.size).toBe(0);
  f.policy.remoteAccessEnabled = true; f.owner.invalidate(); await settle();
  expect(f.active.size).toBe(1);
  f.owner.connection(false); expect(f.active.size).toBe(0);
  f.owner.connection(true); await settle(); expect(f.active.size).toBe(1);
  f.policy.requested = false; f.owner.invalidate(); await settle(); expect(f.active.size).toBe(0);
  f.owner.dispose();
});

test("invalidation and quit reject a late enabled-policy response", async () => {
  const f = fixture(); let resolve!: (value: KeepAwakePolicy) => void;
  f.setRead(() => new Promise(done => { resolve = done; }));
  f.owner.connection(true);
  f.setRead(async () => ({ requested: false, remoteAccessEnabled: true }));
  f.owner.invalidate(); resolve({ requested: true, remoteAccessEnabled: true }); await settle();
  expect(f.starts).toEqual([]);
  f.setRead(() => new Promise(done => { resolve = done; })); f.owner.invalidate();
  f.owner.dispose(); resolve({ requested: true, remoteAccessEnabled: true }); await settle();
  expect(f.starts).toEqual([]);
});

test("failed host and power reads release sleep prevention without resetting preference", async () => {
  const f = fixture(); f.policy.requested = true; f.owner.connection(true); await settle();
  expect(f.active.size).toBe(1);
  f.setRead(async () => { throw Error("Host unavailable"); }); await f.owner.refresh();
  expect(f.active.size).toBe(0); expect(f.owner.status().error).toBe("Host unavailable");
  f.setRead(async () => ({ ...f.policy })); await f.owner.refresh(); expect(f.active.size).toBe(1);
  f.failPower(true); expect(f.active.size).toBe(0); expect(f.owner.status().onBattery).toBeUndefined();
  expect(f.policy.requested).toBe(true); f.owner.dispose();
});

test("unsupported platform never reads policy or requests a blocker", async () => {
  const f = fixture(false); f.setRead(async () => { throw Error("Must not read"); });
  f.owner.connection(true); await f.owner.refresh(); f.battery(false);
  expect(f.starts).toEqual([]); expect(f.owner.status()).toEqual({ supported: false, active: false });
  f.owner.dispose();
});

test("a failed release retains its exact handle for retry and does not claim inactive", async () => {
  const f = fixture(); f.policy.requested = true; f.owner.connection(true); await settle();
  f.failStop(true); f.battery(true);
  expect(f.owner.status().active).toBe(true); expect(f.owner.status().error).toContain("released");
  expect(f.starts).toHaveLength(1); f.failStop(false); f.owner.dispose();
  expect(f.active.size).toBe(0); expect(f.stops).toEqual([1, 1]);
});
