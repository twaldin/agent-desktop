import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { build } from 'vite';
import { createHash } from 'node:crypto';
import type { HostCommand } from '../../../packages/shared/src/protocol';
import { commandEndpoint } from '../../../apps/desktop/src/main/command-endpoints';
const root = resolve(import.meta.dir, '../../..'), output = resolve(process.argv[2] ?? '.data/open-panel-fixture-001');
await mkdir(output, { recursive: true }); if ((await readdir(output)).length) throw new Error('Refusing to overwrite prior fixture evidence.');
const tracked = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, stdout: 'pipe' });
const sourcePaths = [...new Set([...(await new Response(tracked.stdout).text()).split('\0').filter(Boolean), 'apps/desktop/src/renderer/DockActionIcon.tsx', ...(await readdir(import.meta.dir)).map(name => `scripts/acceptance/open-panel-fixture/${name}`)])].sort();
if (await tracked.exited) throw new Error('Could not capture tracked source inventory.');
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
const before = await hashes();
await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2));
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-open-panel-')));
const htmlPreview = process.argv.includes('--html-preview'), suggested = htmlPreview || process.argv.includes('--suggested'), directoryViewer = process.argv.includes('--mcp-owner-viewer'), directoryOwner = directoryViewer || process.argv.includes('--mcp-owner'), artifacts = suggested || process.argv.includes('--artifacts'), mcp = directoryOwner || artifacts || process.argv.includes('--mcp');
if (mcp) {
  const ui = await Bun.build({ entrypoints: [join(import.meta.dir, artifacts || directoryViewer ? 'artifact-view.ts' : 'mcp-view.ts')], target: 'browser', format: 'esm' });
  if (!ui.success) throw new Error(ui.logs.join('\n'));
  await writeFile(join(fixture, 'mcp-ui.html'), '<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;color:#ddd;background:#202020;padding:20px}button{margin:8px;padding:8px}</style><script type="module">' + (await ui.outputs[0]!.text()).replaceAll('</script', '<\/script') + '</script>');
}
const bundleIndex = process.argv.indexOf('--terminal-bundle');
const terminalBundle = bundleIndex < 0 ? undefined : await realpath(resolve(process.argv[bundleIndex + 1]!));
let chrome: string | undefined;
if (suggested) {
  await mkdir(join(fixture, 'tmp'));
  for (const directory of [join(process.env.HOME!, '.omp/puppeteer/chrome'), join(process.env.HOME!, '.cache/puppeteer/chrome')]) {
    for (const version of (await readdir(directory).catch(() => [])).sort().reverse()) {
      const candidate = join(directory, version, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if ((await stat(candidate).catch(() => undefined))?.isFile()) { chrome = candidate; break; }
    }
    if (chrome) break;
  }
  if (!chrome) throw new Error('Suggested website fixture requires an existing Chrome for Testing executable.');
}
const host = Bun.spawn([process.execPath, join(import.meta.dir, 'host.ts'), fixture, ...(terminalBundle ? [terminalBundle] : [])], { env: { HOME: fixture, PATH: process.env.PATH, TMPDIR: suggested ? join(fixture, 'tmp') : tmpdir(), ...(suggested ? { SUGGESTED_OUTPUTS_FIXTURE: '1', ...(htmlPreview ? { HTML_PREVIEW_FIXTURE: '1', HTML_PROVIDER_LOG: join(fixture, 'html-provider.jsonl') } : {}), PUPPETEER_EXECUTABLE_PATH: chrome!, PI_BROWSER_CMUX: '0', PI_BROWSER_RELAY: '0', DEEPINFRA_API_KEY: 'isolated-suggested-fixture', SUGGESTED_PROVIDER_LOG: join(fixture, 'image-provider.jsonl') } : {}), PI_CODING_AGENT_DIR: join(fixture, 'agent'), TERM: 'dumb', AGENT_DESKTOP_NATIVE_TERMINALS: '0', ...(mcp ? { MCP_APP_FIXTURE: '1' } : {}), ...(directoryOwner ? { MCP_OWNER_FIXTURE: '1' } : {}), ...(directoryViewer ? { MCP_OWNER_VIEWER_FIXTURE: '1' } : {}), ...(artifacts ? { ARTIFACT_APP_FIXTURE: '1', ARTIFACT_CONTRACT_GATES: join(fixture, 'gates') } : {}) }, stdin: 'pipe', stdout: Bun.file(join(output, 'host.log')), stderr: Bun.file(join(output, 'host-errors.log')) });
let electron: Bun.Subprocess | undefined;
try {
  const deadline = Date.now() + 40_000;
  while (!await Bun.file(join(fixture, 'connection.json')).exists()) { if (host.exitCode !== null || Date.now() > deadline) throw new Error('Host startup failed.'); await Bun.sleep(100); }
  const connection = JSON.parse(await readFile(join(fixture, 'connection.json'), 'utf8'));
  const command = async (command: HostCommand) => { const envelope = { id: crypto.randomUUID(), command }; const response = await fetch(`${connection.origin}${commandEndpoint(envelope)}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify(envelope) }); const body = await response.json() as any; if (!response.ok || !body.ok) throw new Error(JSON.stringify(body)); return body.value; };
  const git = process.argv.includes('--git');
  if (git) { const initialized = Bun.spawn(['git', '-C', join(fixture, 'project'), 'init', '-q'], { stdout: 'pipe', stderr: 'pipe' }); if (await initialized.exited) throw new Error('Disposable Git initialization failed.'); }
  if (terminalBundle) { const capability = await fetch(`${connection.origin}/v2/terminals/capabilities`, { headers: { Authorization: `Bearer ${connection.token}` } }); const value = await capability.json(); await writeFile(join(output, 'terminal-capabilities.json'), JSON.stringify(value, null, 2)); if (!capability.ok) throw new Error('The real terminal capability is unavailable.'); }
  const project = await command({ type: 'project.add', path: join(fixture, 'project'), name: 'Open panel workspace' });
  const session = directoryOwner ? { id: null } : await command({ type: 'session.create', projectId: project.id });
  if (htmlPreview) {
    const headers = { Authorization: `Bearer ${connection.token}`, 'X-Agent-Host-Id': connection.hostId };
    for (const text of ['html-prepare', 'html-edit']) {
      await command({ type: 'session.prompt', sessionId: session.id, text, model: { provider: 'html-contract', id: 'controlled' }, approvalMode: 'yolo' });
      const deadline = Date.now() + 30_000;
      for (;;) {
        const messages = await (await fetch(`${connection.origin}/v1/sessions/${session.id}/messages`, { headers })).json() as any[];
        const completed = messages.filter(row => row.role === 'assistant' && JSON.stringify(row).includes('The edited website is ready.')).length;
        if (completed >= (text === 'html-prepare' ? 1 : 2)) break;
        if (Date.now() > deadline) { await writeFile(join(output, 'html-setup-messages.json'), JSON.stringify(messages)); throw new Error('Native HTML turn did not complete.'); }
        await Bun.sleep(100);
      }
    }
  } else if (artifacts) {
    await command({ type: 'session.prompt', sessionId: session.id, text: suggested ? 'Create suggested outputs.' : 'Create the original report once.', model: { provider: suggested ? 'suggested-contract' : 'artifact-contract', id: 'controlled' }, approvalMode: 'yolo' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await fetch(`${connection.origin}/v1/sessions/${encodeURIComponent(session.id)}/messages`, { headers: { Authorization: `Bearer ${connection.token}` } });
      const messages = await response.json() as any[];
      if (messages.some(row => row.mcpArtifact)) break;
      if (Date.now() > deadline) { await writeFile(join(output, 'missing-artifact-messages.json'), JSON.stringify(messages, null, 2)); throw new Error('Actual native tool result did not expose an artifact.'); }
      await Bun.sleep(100);
    }
  }
  await writeFile(join(fixture, 'context.json'), JSON.stringify({ projectId: project.id, sessionId: session.id, git, terminal: !!terminalBundle, mcp, artifacts, suggested, htmlPreview, directoryOwner, directoryViewer }));
  await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, 'browser.tsx'))}"></script>`);
  await build({ configFile: join(root, 'apps/desktop/vite.config.ts'), root: output, logLevel: 'warn', build: { outDir: join(output, 'web'), emptyOutDir: true } });
  const compiled = await Bun.build({ entrypoints: [join(import.meta.dir, 'main.ts')], outdir: output, naming: 'main.mjs', target: 'node', format: 'esm', external: ['electron'] }); if (!compiled.success) throw new Error(compiled.logs.join('\n'));
  await writeFile(join(output, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('panelFixture',{call:(method,args)=>ipcRenderer.invoke('panel-call',method,args),subscribe:listener=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('panel-event',handler);return()=>ipcRenderer.removeListener('panel-event',handler);},subscribeNative:listener=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('panel-native',handler);return()=>ipcRenderer.removeListener('panel-native',handler);}});`);
  electron = Bun.spawn([process.execPath, join(root, 'node_modules/electron/cli.js'), join(output, 'main.mjs'), output, fixture], { stdout: Bun.file(join(output, 'electron.log')), stderr: Bun.file(join(output, 'electron-errors.log')) });
  const timer = setTimeout(() => electron!.kill('SIGTERM'), 90_000), code = await electron.exited; clearTimeout(timer);
  if (code) throw new Error(`Electron flow failed (${code}); see ${output}`);
} finally {
  if (electron?.exitCode === null) { electron.kill('SIGTERM'); await electron.exited; }
  if (host.exitCode === null) { host.stdin.write('stop\n'); host.stdin.end(); }
  const timer = setTimeout(() => host.kill('SIGKILL'), 15_000), hostExit = await host.exited; clearTimeout(timer);
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ hostExit, electronExit: electron?.exitCode, fixture }));
  const after = await hashes(); await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during the fixture; this run is not a stable final result.');
  if (mcp && await Bun.file(join(fixture, 'mcp-requests.jsonl')).exists()) await writeFile(join(output, 'mcp-requests.jsonl'), await readFile(join(fixture, 'mcp-requests.jsonl')));
  if (hostExit === 0) await rm(fixture, { recursive: true, force: true }); else throw new Error('Host cleanup failed; isolated files retained.');
}
