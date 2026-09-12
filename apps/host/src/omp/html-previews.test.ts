import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HtmlPreviews } from './html-previews';
const request = { epoch: 'epoch', output: { kind: 'html-preview' as const, branch: 'b'.repeat(64), path: '', entryId: 'html', turnId: 'turn', revision: 'a'.repeat(64), label: 'index.html' } };
const saved = (id: string, path: string) => ({ id, message: { role: 'toolResult', toolName: 'write', isError: false, details: { resolvedPath: path } } });
async function setup() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'html-preview-'))); await writeFile(join(cwd, 'index.html'), '<h1>Original</h1>');
  return { cwd, input: { ...request, output: { ...request.output, path: join(cwd, 'index.html') } }, entries: [saved('html', join(cwd, 'index.html'))], previews: new HtmlPreviews() };
}
test('nonce, original source and recorded asset allowlist survive arbitrary request paths', async () => {
  const f = await setup(); let current = true;
  try {
    await writeFile(join(f.cwd, 'style.css'), 'h1 { color: blue; }'); await writeFile(join(f.cwd, 'private.json'), '{"secret":true}');
    const lease = await f.previews.open(f.input, f.cwd, [...f.entries, saved('css', join(f.cwd, 'style.css'))], async () => current);
    expect(await (await fetch(lease.url)).text()).toContain('Original');
    expect((await fetch(new URL('style.css', lease.url))).headers.get('content-type')).toBe('text/css');
    for (const path of ['private.json', '../private.json', '%2e%2e/private.json', '%2fprivate.json']) expect((await fetch(new URL(path, lease.url))).status).toBe(410);
    expect((await fetch(new URL('/wrong/index.html', lease.url))).status).toBe(410);
    expect((await fetch(lease.url)).status).toBe(200);
    current = false; expect((await fetch(lease.url)).status).toBe(410); expect(f.previews.active).toBe(false);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});
test('directory and recorded-file identity loss deny subsequent serving', async () => {
  const f = await setup();
  try {
    const lease = await f.previews.open(f.input, f.cwd, f.entries, async () => true);
    await writeFile(f.input.output.path, '<h1>Different revision</h1>');
    expect((await fetch(lease.url)).status).toBe(410); expect(f.previews.active).toBe(false);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});
test('a recorded path symlink cannot grant files outside its original workspace', async () => {
  const f = await setup(), other = await mkdtemp(join(tmpdir(), 'html-outside-'));
  try {
    await writeFile(join(other, 'outside.js'), 'outside'); await symlink(join(other, 'outside.js'), join(f.cwd, 'outside.js'));
    await expect(f.previews.open(f.input, f.cwd, [...f.entries, saved('outside', join(f.cwd, 'outside.js'))], async () => true)).rejects.toThrow('outside');
    expect(f.previews.active).toBe(false);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
test('disposal during final ownership await drains open and never publishes a new server lease', async () => {
  const f = await setup(); let enter!: () => void, finish!: (value: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<boolean>(resolve => { finish = resolve; });
  try {
    const opening = f.previews.open(f.input, f.cwd, f.entries, async () => { enter(); return held; }); await entered;
    let settled = false; const disposal = f.previews.dispose().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    finish(true); await expect(opening).rejects.toThrow('no longer available'); await disposal; expect(settled).toBe(true); expect(f.previews.active).toBe(false);
  } finally { finish?.(false); await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});
test('leases and admitted output counts are bounded and release permits a fresh deliberate preview', async () => {
  const f = await setup();
  try {
    const leases = []; for (let i = 0; i < 4; i++) leases.push(await f.previews.open(f.input, f.cwd, f.entries, async () => true));
    await expect(f.previews.open(f.input, f.cwd, f.entries, async () => true)).rejects.toThrow('Close an existing');
    f.previews.release(leases[0]!.leaseId); expect((await fetch(leases[0]!.url)).status).toBe(410);
    const fresh = await f.previews.open(f.input, f.cwd, f.entries, async () => true); expect(fresh.url).not.toBe(leases[0]!.url); expect((await fetch(fresh.url)).status).toBe(200);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});

test('ownership loss in the final read check retires the URL permanently even after a later return', async () => {
  const f = await setup(); let checks = 0, loseAtFinalRead = false;
  try {
    const lease = await f.previews.open(f.input, f.cwd, f.entries, async () => { checks++; return !(loseAtFinalRead && checks === 3); });
    loseAtFinalRead = true;
    expect((await fetch(lease.url)).status).toBe(410); expect(checks).toBe(3); expect(f.previews.active).toBe(false);
    loseAtFinalRead = false;
    expect((await fetch(lease.url)).status).toBe(410); expect(checks).toBe(3);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});

test('the reused workspace reader enforces its 2 MiB bound before issuing any preview URL', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.cwd, 'large.js'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(f.previews.open(f.input, f.cwd, [...f.entries, saved('large', join(f.cwd, 'large.js'))], async () => true)).rejects.toThrow('2097152-byte');
    expect(f.previews.active).toBe(false);
  } finally { await f.previews.dispose(); await rm(f.cwd, { recursive: true, force: true }); }
});
