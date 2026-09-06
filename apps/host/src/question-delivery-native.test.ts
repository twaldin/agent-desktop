import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detachedAnswerDraft, SESSION_ACTIVITY_OWNER_HEADER, type CommandResult, type DetachedQuestionSnapshot, type HostCommand, type SessionSummary } from '@agent-desktop/shared';
import { startHost } from './server';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-desktop-question-http-')));
  const agentDirectory = path.join(root, 'agent'), project = path.join(root, 'project'), gates = path.join(root, 'gates');
  await Promise.all([agentDirectory, project, gates].map(folder => mkdir(folder)));
  await writeFile(path.join(agentDirectory, 'config.yml'), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL('./omp-workers/fixtures/detached-question-provider.ts', import.meta.url)))}\nretry:\n  enabled: false\n`);
  const workerPath = path.join(root, 'worker.ts');
  await writeFile(workerPath, `process.env.DETACHED_QUESTION_GATES=${JSON.stringify(gates)};\nawait import(${JSON.stringify(fileURLToPath(new URL('./omp-workers/fixtures/no-provider-worker.ts', import.meta.url)))});\n`);
  const options = { dataDirectory: path.join(root, 'data'), agentDirectory, discoveryDirectory: project, workerPath, tailscale: false };
  let host = await startHost(options);
  const request = (route: string, init: RequestInit = {}) => fetch(host.connection.origin + route, { ...init, headers: { Authorization: `Bearer ${host.connection.token}`, [SESSION_ACTIVITY_OWNER_HEADER]: host.connection.hostId, ...init.headers } });
  const command = async (command: HostCommand, id = crypto.randomUUID()): Promise<CommandResult> => {
    const response = await request('/v3/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, command }) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
    const until = Date.now() + 10_000;
    while (!await check() && Date.now() < until) await Bun.sleep(10);
    if (!await check()) throw new Error(`Timed out: ${label}`);
  };
  const questions = async (id: string) => {
    const response = await request(`/v1/sessions/${id}/questions`); expect(response.status).toBe(200);
    const result = await response.json() as { questions: DetachedQuestionSnapshot[] }; return result.questions;
  };
  return { root, gates, project, command, questions, wait, request, get host() { return host; },
    restart: async () => { await host.stop(); host = await startHost(options); },
    release: () => writeFile(path.join(gates, 'hold.release'), ''), close: async () => { await host.stop(); await rm(root, { recursive: true, force: true }); } };
}
async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.command({ type: 'session.create', projectId: null, cwd: f.project });
  if (!created.ok || !created.value || !('sessionFile' in created.value)) throw new Error('Native session creation failed');
  const session = created.value as SessionSummary;
  expect((await f.command({ type: 'session.prompt', sessionId: session.id, text: 'Ask while doing independent work', model: { provider: 'detached-contract', id: 'controlled' } })).ok).toBe(true);
  await f.wait(() => Bun.file(path.join(f.gates, 'hold.started')).exists(), 'shared native tool');
  await f.wait(async () => (await f.questions(session.id)).some(question => question.status === 'open'), 'detached question');
  return { session, question: (await f.questions(session.id))[0]! };
}
const answers = [{ questionId: 'density', selectedOptions: ['Compact'] }, { questionId: 'note', selectedOptions: [], customInput: 'Cobalt' }];

test('two clients resolve once through the owning host; native steer delivers one ordinary message and consumes only its saved draft', async () => {
  const f = await fixture();
  try {
    const { session, question } = await begin(f);
    const draftId = `question:${session.id}:${question.questionId}`;
    expect((await f.command({ type: 'draft.put', draft: { id: draftId, text: detachedAnswerDraft(answers), projectId: null, model: null }, expectedRevision: 0 })).ok).toBe(true);
    const answer: HostCommand = { type: 'session.question.answer', sessionId: session.id, questionId: question.questionId, questionEntryId: question.questionEntryId, answers, draft: { id: draftId, revision: 1 } };
    const commandId = crypto.randomUUID();
    const [first, second] = await Promise.all([f.command(answer, commandId), f.command(answer)]);
    expect([first, second].filter(result => result.ok)).toHaveLength(1);
    expect(first.ok).toBe(true); expect(await f.command(answer, commandId)).toEqual(first);
    expect(f.host.store.getDraft(draftId)).toMatchObject({ text: '', revision: 2 });
    await f.wait(async () => (await readFile(session.sessionFile, 'utf8')).includes('agent-desktop.question-delivery-attempt'), 'native steer attempt before releasing independent work');
    await f.release();
    await f.wait(async () => (await f.questions(session.id))[0]?.delivery.status === 'delivered', 'native answer delivery');
    await f.wait(() => f.host.store.getSession(session.id)?.status === 'idle', 'actual native completion');
    const snapshot = (await f.questions(session.id))[0]!;
    expect(snapshot).toMatchObject({ status: 'accepted', delivery: { status: 'delivered', mode: 'steer' } });
    const entries = (await readFile(session.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const delivered = entries.filter(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('Answers to detached question'));
    expect(delivered).toHaveLength(1); expect(JSON.stringify(delivered[0])).toContain('Cobalt');
    expect((await f.request(`/v1/sessions/${session.id}/questions`, { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: 'wrong-owner' } })).status).toBe(409);
  } finally { await f.close(); }
}, 40_000);

test('accepted answers survive restart while ordinary drafts hold delivery; clearing the draft wakes one idle native follow-up', async () => {
  const f = await fixture();
  try {
    const { session, question } = await begin(f);
    const ordinary = `session:${session.id}`, draftId = `question:${session.id}:${question.questionId}`;
    expect((await f.command({ type: 'draft.put', draft: { id: ordinary, text: 'Preserve unsent work', projectId: null, model: null }, expectedRevision: 0 })).ok).toBe(true);
    expect((await f.command({ type: 'draft.put', draft: { id: draftId, text: detachedAnswerDraft(answers), projectId: null, model: null }, expectedRevision: 0 })).ok).toBe(true);
    expect((await f.command({ type: 'session.question.answer', sessionId: session.id, questionId: question.questionId, questionEntryId: question.questionEntryId, answers, draft: { id: draftId, revision: 1 } })).ok).toBe(true);
    await f.release(); await f.wait(() => f.host.store.getSession(session.id)?.status === 'idle', 'origin completion');
    expect((await f.questions(session.id))[0]).toMatchObject({ status: 'accepted', delivery: { status: 'waiting' } });
    await f.restart();
    expect((await f.questions(session.id))[0]).toMatchObject({ status: 'accepted', delivery: { status: 'waiting' } });
    expect(f.host.store.getDraft(ordinary)?.text).toBe('Preserve unsent work');
    expect((await f.command({ type: 'draft.put', draft: { id: ordinary, text: '', projectId: null, model: null }, expectedRevision: 1 })).ok).toBe(true);
    await f.wait(async () => (await f.questions(session.id))[0]?.delivery.status === 'delivered', 'restart delivery');
    expect((await f.questions(session.id))[0]).toMatchObject({ delivery: { status: 'delivered', mode: 'followUp' } });
  } finally { await f.close(); }
}, 40_000);
