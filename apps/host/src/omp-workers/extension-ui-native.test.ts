import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerRuntime } from "./runtime";
import { ExtensionUiHttp } from "../extension-ui-http";
import { EXTENSION_UI_OWNER_HEADER } from "../../../../packages/shared/src/extension-ui";

test("real extension startup, commands and event updates retain each original owner across reads and reject disposal", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-extension-ui-"))), agentDir = path.join(root, "agent"), one = path.join(root, "one"), two = path.join(root, "two");
  await Promise.all([agentDir, one, two].map(directory => mkdir(directory)));
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, "fixtures/extension-ui.ts"))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "fixtures/no-provider-worker.ts"), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  const events: unknown[] = [];
  try {
    const first = await runtime.create({ cwd: one, interactions: true, onEvent: event => events.push(event) }), second = await runtime.create({ cwd: two, interactions: true });
    expect((await first.getExtensionUi()).statuses).toEqual([]);
    expect(await first.prompt("/extension-ui-fixture startup")).toBe(false);
    expect(await second.prompt("/extension-ui-fixture startup")).toBe(false);
    for (let i = 0; i < 100 && (await first.getExtensionUi()).widgets.length !== 3; i++) await Bun.sleep(20);
    const initial = await first.getExtensionUi(), other = await second.getExtensionUi();
    expect(initial.statuses).toEqual([{ key: "__proto__", text: "Native status ready" }, { key: "z", text: "one ready" }]);
    expect(other.statuses.at(-1)?.text).toBe("two ready"); expect(other.epoch).not.toBe(initial.epoch);
    expect(initial.widgets.map(widget => [widget.key, widget.placement])).toEqual([["first", "aboveEditor"], ["second", "aboveEditor"], ["below", "belowEditor"]]);
    const transcriptBefore = await readFile(first.sessionFile, "utf8");
    expect(await first.prompt("/extension-ui-fixture replace")).toBe(false);
    expect((await first.getExtensionUi()).widgets.map(widget => widget.key)).toEqual(["second", "first", "below"]);
    expect((await first.getExtensionUi()).widgets.every(widget => widget.placement === "aboveEditor")).toBe(true);
    await first.prompt("/extension-ui-fixture event"); expect((await first.getExtensionUi()).statuses.at(-1)?.text).toBe("one event update");
    await first.prompt("/extension-ui-fixture clear"); expect((await first.getExtensionUi()).statuses.map(status => status.key)).toEqual(["z"]);
    await first.prompt("/extension-ui-fixture long"); expect((await first.getExtensionUi()).widgets.at(-1)).toMatchObject({ key: "first", lines: Array.from({ length: 10 }, (_, index) => `Native line ${index + 1}`), truncated: true });
    await first.prompt("/extension-ui-fixture factory"); expect(await readFile(path.join(one, "factory-result"), "utf8")).toContain("setWidget(component factory)");
    expect(await readFile(first.sessionFile, "utf8")).toBe(transcriptBefore); expect((await second.getExtensionUi()).statuses).toEqual(other.statuses);
    let owner: typeof first | undefined = first;
    const route = new ExtensionUiHttp({ hostId: "host", sessionExists: id => [first.id, "inactive"].includes(id), existing: async id => id === first.id ? owner : undefined });
    const read = async (id: string, header = "host") => route.route(new Request(`http://localhost/v1/sessions/${id}/extension-ui`, { headers: { [EXTENSION_UI_OWNER_HEADER]: header } }));
    expect((await read(first.id, "foreign"))?.status).toBe(409);
    expect(await (await read("inactive"))!.json()).toMatchObject({ availability: "unavailable" });
    const wire = await (await read(first.id))!.json(); expect(wire).toMatchObject({ availability: "available", value: { epoch: initial.epoch } });
    expect(await (await read(first.id))!.json()).toEqual(wire); // Reconnection is a read, not replay/startup.
    await first.dispose(); owner = undefined;
    expect(await readFile(path.join(one, "disposed-result"), "utf8")).toBe("late write rejected");
    expect(await (await read(first.id))!.json()).toMatchObject({ availability: "unavailable" });
    await expect(first.getExtensionUi()).rejects.toThrow(); expect((await second.getExtensionUi()).epoch).toBe(other.epoch);
    expect(events.some((event: any) => event.type === "extension_ui_changed" && event.epoch === initial.epoch)).toBe(true);
    await second.prompt("/extension-ui-fixture allclear"); expect((await second.getExtensionUi()).widgets).toEqual([]); expect((await second.getExtensionUi()).statuses).toEqual([]);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30000);
