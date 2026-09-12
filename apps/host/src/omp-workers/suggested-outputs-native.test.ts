import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerRuntime } from './runtime';
test('actual native saved write, generated image and MCP result restore as Suggested without replay', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-suggested-'))), agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project'), log = path.join(root, 'mcp.jsonl'), imageLog = path.join(root, 'images.jsonl');
  await Promise.all([agentDir, cwd].map(value => mkdir(value)));
  await writeFile(path.join(cwd, 'input.md'), '# Input document'); await writeFile(path.join(cwd, 'blocked'), 'A regular file, not an output directory.');
  await writeFile(path.join(agentDir, 'config.yml'), `generate_image:\n  enabled: true\nextensions:\n  - ${JSON.stringify(path.join(import.meta.dir, 'fixtures/suggested-provider.ts'))}\nretry:\n  enabled: false\n`);
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(import.meta.dir, '../omp/fixtures/artifact-server.ts')], env: { ARTIFACT_TEST_LOG: log } } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, 'fixtures/suggested-worker.ts'), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: 'dumb', DEEPINFRA_API_KEY: 'isolated-suggested-fixture', SUGGESTED_PROVIDER_LOG: imageLog } });
  let generatedPath: string | undefined;
  try {
    let session = await runtime.create({ cwd, interactions: true, approvalOverride: 'yolo' });
    await session.prompt('Create suggested outputs.', { model: { provider: 'suggested-contract', id: 'controlled' } });
    const outputs = await session.getSessionOutputs();
    if (process.env.SUGGESTED_EVIDENCE_DIRECTORY) { await mkdir(process.env.SUGGESTED_EVIDENCE_DIRECTORY, { recursive: true }); await writeFile(path.join(process.env.SUGGESTED_EVIDENCE_DIRECTORY, 'native.jsonl'), await readFile(session.sessionFile)); await writeFile(path.join(process.env.SUGGESTED_EVIDENCE_DIRECTORY, 'outputs.json'), JSON.stringify(outputs, null, 2)); }
    expect(outputs.outputs.map(row => row.kind)).toEqual(['mcp', 'generated-image', 'file']);
    expect(outputs.outputs.some(row => 'path' in row && /input|failed/.test(row.path))).toBe(false);
    const generated = outputs.outputs.find(row => row.kind === 'generated-image')!; if (generated.kind !== 'generated-image') throw new Error('Missing actual native generated output');
    generatedPath = generated.path;
    expect((await session.getImage(generated.entryId, generated.imageIndex, 'generated')).sha256).toBe(generated.sha256);
    const saved = session.sessionFile; await session.dispose(); session = await runtime.open({ sessionFile: saved, interactions: true, approvalOverride: 'yolo' });
    const restored = await session.getSessionOutputs(); expect(restored.outputs).toEqual(outputs.outputs); expect(restored.epoch).not.toBe(outputs.epoch);
    expect((await readFile(imageLog, 'utf8')).trim().split('\n')).toHaveLength(1);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); expect(calls.filter(call => call.method === 'tools/call' && call.params.name === 'report')).toHaveLength(1);
    await session.prompt('overwrite-output', { model: { provider: 'suggested-contract', id: 'controlled' } });
    const latest = await session.getSessionOutputs(); expect(latest.outputs.filter(row => row.kind === 'file')).toHaveLength(1); expect(latest.outputs[0]?.entryId).not.toBe(outputs.outputs[0]?.entryId);
    await rm(path.join(cwd, 'summary.md')); expect((await session.getSessionOutputs()).outputs.some(row => row.kind === 'file')).toBe(false);
    await session.dispose();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); if (generatedPath) await rm(generatedPath, { force: true }); }
}, 60_000);
