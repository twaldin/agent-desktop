import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { PreferencesStore } from "./store";
import { parsePreferenceChange } from "../../../../packages/shared/src/preferences";

test("dock preferences replicate and restart while preserving the independent terminal choice", () => {
  const root = mkdtempSync(join(tmpdir(), "general-dock-preferences-")), stores: HostStore[] = [];
  const open = (name: string) => { const store = new HostStore(join(root,name)); stores.push(store); return new PreferencesStore(store); };
  try {
    const a = open("a"), b = open("b");
    expect(a.get("general.bottomPanel")).toBeUndefined();
    expect(a.get("general.defaultTerminalLocation")).toBeUndefined();
    expect(() => parsePreferenceChange({key:"general.bottomPanel",value:"false"})).toThrow();
    expect(() => parsePreferenceChange({key:"general.defaultTerminalLocation",value:"left"})).toThrow();
    a.put({key:"general.defaultTerminalLocation",value:"bottom"});
    a.put({key:"general.bottomPanel",value:false}); b.merge(a.snapshot());
    expect(b.get("general.bottomPanel")).toMatchObject({deleted:false,value:false});
    expect(b.get("general.defaultTerminalLocation")).toMatchObject({deleted:false,value:"bottom"});
    expect(open("b").snapshot()).toEqual(b.snapshot());
    const old = a.snapshot(); b.put({key:"general.bottomPanel",deleted:true}); a.merge(b.snapshot()); a.merge(old);
    expect(a.get("general.bottomPanel")).toMatchObject({deleted:true});
    expect(a.get("general.defaultTerminalLocation")).toMatchObject({value:"bottom"});
    a.put({key:"general.defaultTerminalLocation",value:"right"});b.merge(a.snapshot());
    expect(b.get("general.defaultTerminalLocation")).toMatchObject({value:"right"});
  } finally { for(const store of stores)store.close();rmSync(root,{recursive:true,force:true}); }
});
