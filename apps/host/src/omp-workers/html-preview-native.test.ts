import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntime } from './runtime';
test('actual EditTool saved outcome serves only original recorded HTML and relative output assets', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-html-'))), agentDir = join(root, 'agent'), cwd = join(root, 'project');
  await mkdir(agentDir); await mkdir(cwd); await mkdir(join(cwd, 'site'));
  await writeFile(join(cwd, 'site', 'private.json'), '{"not":"a recorded output"}');
  await writeFile(join(agentDir, 'config.yml'), `edit:\n  mode: replace\nextensions:\n  - ${JSON.stringify(join(import.meta.dir, 'fixtures/html-provider.ts'))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: join(import.meta.dir, 'fixtures/no-provider-worker.ts'), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, PI_EDIT_VARIANT: 'replace', TERM: 'dumb' } });
  try {
    let session = await runtime.create({ cwd, interactions: true, approvalOverride: 'yolo' });
    await session.prompt('html-prepare', { model: { provider: 'html-contract', id: 'controlled' } });
    await session.prompt('html-edit', { model: { provider: 'html-contract', id: 'controlled' } });
    const outputs = await session.getSessionOutputs(), output = outputs.outputs.find(value => value.kind === 'html-preview');
    if (process.env.HTML_EVIDENCE_DIRECTORY) { await mkdir(process.env.HTML_EVIDENCE_DIRECTORY, { recursive: true }); await writeFile(join(process.env.HTML_EVIDENCE_DIRECTORY, 'native.jsonl'), await readFile(session.sessionFile)); await writeFile(join(process.env.HTML_EVIDENCE_DIRECTORY, 'outputs.json'), JSON.stringify(outputs)); }
    expect(output?.kind).toBe('html-preview'); if (output?.kind !== 'html-preview') throw new Error('Missing actual EditTool HTML output');
    const preview = await session.openHtmlPreview({ epoch: outputs.epoch, output });
    const main = await fetch(preview.url); expect(main.status).toBe(200); expect(await main.text()).toContain('Actual native edited HTML');
    for (const [name, expected] of [['style.css', 'rgb(12, 100, 180)'], ['app.js', 'original-recorded-script'], ['image.svg', '<svg'], ['about.html', 'Saved relative page']]) {
      const response = await fetch(new URL(name!, preview.url)); expect(response.status).toBe(200); expect(await response.text()).toContain(expected!);
    }
    expect((await fetch(new URL('private.json', preview.url))).status).toBe(410);
    expect((await fetch(preview.url, { method: 'POST' })).status).toBe(405);
    await writeFile(join(cwd, 'site', 'app.js'), 'replacement');
    expect((await fetch(new URL('app.js', preview.url))).status).toBe(410);
    expect((await fetch(preview.url)).status).toBe(410);
    const current = await session.getSessionOutputs(), again = await session.openHtmlPreview({ epoch: current.epoch, output });
    await session.releaseHtmlPreview(again.leaseId); expect((await fetch(again.url)).status).toBe(410);
    const saved = session.sessionFile; await session.dispose();
    session = await runtime.open({ sessionFile: saved, interactions: true, approvalOverride: 'yolo' });
    await expect(session.openHtmlPreview({ epoch: outputs.epoch, output })).rejects.toThrow('worker changed');
    await session.dispose();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
