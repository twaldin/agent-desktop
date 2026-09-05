import { expect, test } from "bun:test";
import { COMPOSER_OWNER_HEADER } from "@agent-desktop/shared";
import { ComposerActionsHttp } from "./composer-actions-http";

const catalog = (cwd: string) => ({ protocolVersion: 1 as const, cwd, revision: "a".repeat(64), commands: [], skills: [], diagnostics: [] });
const request = (body: unknown, owner = "owner") => new Request("http://host/v1/composer/actions", {
  method: "POST", headers: { "Content-Type": "application/json", [COMPOSER_OWNER_HEADER]: owner }, body: JSON.stringify(body),
});

test("composer HTTP refuses stale owners and targets before native discovery", async () => {
  let calls = 0;
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: target => {
    if (target && "projectId" in target && target.projectId === "gone") throw new Error("gone");
    return "/owned";
  }, getHandle: async () => { throw new Error("unexpected session"); }, runtime: {
    getComposerActions: async cwd => { calls++; return catalog(cwd ?? "/owned"); },
    getComposerCompletions: async () => { throw new Error("unexpected completions"); },
  } });
  const wrong = await http.route(request({}, "other"));
  expect(wrong?.status).toBe(409); expect(await wrong?.json()).toMatchObject({ error: { code: "OWNER_MISMATCH" } });
  const stale = await http.route(request({ target: { projectId: "gone" } }));
  expect(stale?.status).toBe(409); expect(await stale?.json()).toMatchObject({ error: { code: "STALE_TARGET" } });
  expect(calls).toBe(0);
});

test("composer HTTP rechecks target ownership after native discovery", async () => {
  let current = "/owned";
  const http = new ComposerActionsHttp({ hostId: "owner", resolveCwd: () => current,
    getHandle: async () => { throw new Error("unexpected session"); }, runtime: {
      getComposerActions: async cwd => { current = "/moved"; return catalog(cwd ?? "/owned"); },
      getComposerCompletions: async () => { throw new Error("unexpected completions"); },
    } });
  const response = await http.route(request({ target: { projectId: "project" } }));
  expect(response?.status).toBe(409); expect(await response?.json()).toMatchObject({ error: { code: "STALE_TARGET" } });
});
