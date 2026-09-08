import { expect, test } from "bun:test";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { commandEndpoint, requestVersionedCommand, requestVersionedControl } from "./command-endpoints";
import { HostRequestError, requestHost } from "./host-transport";

test('environment-aware drafts and consumption never downgrade to an older endpoint', async () => {
  const envelopes: CommandEnvelope[] = [
    { id: 'select-action-config', command: { type: 'workspace.mutate', target: {projectId: 'p'}, action: {type: 'environment.select', configPath: null, expectedRevision: 0} } },
    { id: 'run-action', command: { type: 'workspace.mutate', target: {sessionId: 's'}, action: {type: 'environment.action', configPath: '/owned/config.toml', configRevision: 'a'.repeat(64), selectionRevision: 1, actionIndex: 0} } },
    { id: 'clear-environment', command: { type: 'draft.put', expectedRevision: 2, draft: { id: 'd', text: 'keep', projectId: null, model: null, environment: null } } },
    { id: 'create-without-environment', command: { type: 'session.create', projectId: 'p', worktree: { type: 'working-tree' }, environment: null, draft: { id: 'd', revision: 3 } } },
    { id: 'consume-environment-draft', commandVersion: 5, command: { type: 'session.prompt', sessionId: 's', text: 'keep', draft: { id: 'd', revision: 3 } } },
  ];
  for (const envelope of envelopes) {
    const calls: string[] = [];
    expect(commandEndpoint(envelope)).toBe('/v5/commands');
    expect(await requestVersionedCommand(async path => { calls.push(path); throw new HostRequestError('Not found', 404); }, envelope))
      .toMatchObject({ ok: false, commandId: envelope.id, error: { code: 'ENVIRONMENT_PROTOCOL_UNSUPPORTED' } });
    expect(calls).toEqual(['/v5/commands']);
    for (const error of [new Error('Lost response'), new HostRequestError('Not authorized', 401), new HostRequestError('Config missing', 404, 'CONFIG_NOT_FOUND')])
      await expect(requestVersionedCommand(async () => { throw error; }, envelope)).rejects.toBe(error);
  }
});

test('an older host cannot silently discard worktree choices or consume their draft through a fallback', async () => {
  const paths: string[] = [];
  const old = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    return path === '/v4/commands' ? Response.json({ error: 'Not found' }, { status: 404 }) : Response.json({ ok: true });
  } });
  const envelopes: CommandEnvelope[] = [
    { id: 'worktree', command: { type: 'session.create', projectId: 'p', worktree: { type: 'working-tree' } } },
    { id: 'local-again', command: { type: 'draft.put', expectedRevision: 2, draft: { id: 'd', text: 'keep', projectId: 'p', model: null, execution: { type: 'local' }, attachments: [] } } },
    { id: 'consume', commandVersion: 4, command: { type: 'session.prompt', sessionId: 's', text: 'keep', draft: { id: 'd', revision: 3 } } },
  ];
  try {
    for (const envelope of envelopes) {
      expect(await requestVersionedCommand((path, body) => requestHost({ origin: old.url.origin, hostId: 'old' }, path, body), envelope))
        .toMatchObject({ ok: false, error: { code: 'NEW_CHAT_PROTOCOL_UNSUPPORTED' } });
      const lost = new Error('Connection lost after creation');
      await expect(requestVersionedCommand(async () => { throw lost; }, envelope)).rejects.toBe(lost);
    }
    expect(paths).toEqual(['/v4/commands', '/v4/commands', '/v4/commands']);
  } finally { old.stop(true); }
});

test("sticky image manifests require v3 even when empty and never fall back after an old host or uncertain delivery", async () => {
  const envelopes: CommandEnvelope[] = [
    { id: "draft", command: { type: "draft.put", expectedRevision: 1, draft: { id: "d", projectId: null, text: "kept", model: null, attachments: [] } } },
    { id: "prompt", command: { type: "session.prompt", sessionId: "s", text: "kept", attachments: [], approvalMode: "write" } },
    { id: "steer", command: { type: "session.steer", sessionId: "s", text: "kept", attachments: [] } },
  ];
  for (const envelope of envelopes) {
    const paths: string[] = [];
    expect(commandEndpoint(envelope)).toBe("/v3/commands");
    expect(await requestVersionedCommand(async path => { paths.push(path); throw new HostRequestError("Not found", 404); }, envelope)).toMatchObject({ ok: false, commandId: envelope.id, error: { code: "ATTACHMENT_PROTOCOL_UNSUPPORTED" } });
    expect(paths).toEqual(["/v3/commands"]);
    for (const error of [new Error("socket lost"), new HostRequestError("Unauthorized", 401), new HostRequestError("Image missing", 404, "IMAGE_NOT_FOUND")]) {
      await expect(requestVersionedCommand(async () => { throw error; }, envelope)).rejects.toBe(error);
    }
  }
});

test("an old HTTP host cannot silently strip a permission choice or receive a fallback copy", async () => {
  const requests: string[] = [];
  const old = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    return path.startsWith("/v2/") ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({ ok: true });
  } });
  const draft = { id: "new-conversation", text: "retained", projectId: null, model: null, approvalMode: "always-ask" as const };
  const envelopes: CommandEnvelope[] = [
    { id: "save", command: { type: "draft.put", draft, expectedRevision: 0 } },
    { id: "create", command: { type: "session.create", projectId: null, approvalMode: "always-ask" } },
    { id: "prompt", command: { type: "session.prompt", sessionId: "s", text: "retained", approvalMode: "write" } },
    { id: "steer", command: { type: "session.steer", sessionId: "s", text: "retained", approvalMode: "yolo" } },
  ];
  try {
    const request = (path: string, body: unknown) => requestHost({ origin: old.url.origin, hostId: "old" }, path, body);
    for (const envelope of envelopes) expect(await requestVersionedCommand(request, envelope)).toMatchObject({ ok: false, commandId: envelope.id, error: { code: "PERMISSION_PROTOCOL_UNSUPPORTED" } });
    expect(requests).toEqual(envelopes.map(() => "/v2/commands"));
    await expect(requestVersionedControl(request, "session/owned", { expectedRevision: "r", operation: "override", path: "tools.approvalMode", value: "write" })).rejects.toThrow("Update the owning host");
    await expect(requestVersionedControl(request, "s", { expectedRevision: "r", operation: "clear-override", path: "tools.approvalMode" })).rejects.toThrow("Update the owning host");
    expect(requests.slice(-2)).toEqual(["/v2/sessions/session%2Fowned/controls", "/v2/sessions/s/controls"]);
    const ordinary: CommandEnvelope = { id: "ordinary", command: { type: "session.prompt", sessionId: "s", text: "unchanged", approvalMode: undefined } };
    expect(commandEndpoint(ordinary)).toBe("/v1/commands");
    expect(await requestVersionedCommand(request, ordinary)).toEqual({ ok: true });
  } finally { old.stop(true); }
});

test("an uncertain policy delivery or coded error is never changed into a definite rejection", async () => {
  const envelope: CommandEnvelope = { id: "original", command: { type: "session.create", projectId: null, approvalMode: "write" } };
  for (const error of [new Error("socket lost after admission"), new HostRequestError("denied", 401), new HostRequestError("native file missing", 404, "NATIVE_MISSING")]) {
    let calls = 0;
    await expect(requestVersionedCommand(async () => { calls++; throw error; }, envelope)).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});


test("selected snapshots and cleared markers use only v6 without losing uncertain outcomes", async () => {
  const envelopes: CommandEnvelope[] = [
    { id: "selected-draft", command: { type: "draft.put", expectedRevision: 1, draft: { id: "d", text: "", projectId: null, model: null, selectedTextAttachments: [], attachments: [], environment: null } } },
    { id: "selected-send", command: { type: "session.prompt", sessionId: "s", text: "text", selectedTextAttachments: [] } },
    { id: "selected-consume", commandVersion: 6, command: { type: "session.btw.start", sessionId: "s", question: "question", draft: { id: "d", revision: 1 } } },
  ];
  for (const envelope of envelopes) {
    const paths: string[] = [];
    expect(commandEndpoint(envelope)).toBe("/v6/commands");
    expect(await requestVersionedCommand(async path => { paths.push(path); throw new HostRequestError("Not found", 404); }, envelope))
      .toMatchObject({ ok: false, error: { code: "SELECTED_TEXT_PROTOCOL_UNSUPPORTED" } });
    expect(paths).toEqual(["/v6/commands"]);
    for (const error of [new Error("Lost response"), new HostRequestError("Not authorized", 401), new HostRequestError("Target missing", 404, "NOT_FOUND")])
      await expect(requestVersionedCommand(async () => { throw error; }, envelope)).rejects.toBe(error);
  }
});

test('whole-file and sticky cleared descriptors use v7 without fallback',async()=>{
 const envelope:CommandEnvelope={id:'whole',command:{type:'draft.put',expectedRevision:2,draft:{id:'draft',text:'',projectId:null,model:null,wholeFileAttachments:[],selectedTextAttachments:[]}}};
 expect(commandEndpoint(envelope)).toBe('/v7/commands');const paths:string[]=[];
 expect(await requestVersionedCommand(async path=>{paths.push(path);throw new HostRequestError('Not found',404);},envelope)).toMatchObject({ok:false,error:{code:'WHOLE_FILE_PROTOCOL_UNSUPPORTED'}});
 expect(paths).toEqual(['/v7/commands']);
 const error=new Error('Lost response');await expect(requestVersionedCommand(async()=>{throw error;},envelope)).rejects.toBe(error);
});
