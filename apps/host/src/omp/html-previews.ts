import { relative, extname } from 'node:path';
import { WorkspaceService } from '../workspace/service';
import type { HtmlPreviewLease, HtmlPreviewRequest } from '../../../../packages/shared/src/html-preview';
import { recordedOutputFiles, type OutputEntry } from './session-outputs';
const TYPES: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const MAX_FILES = 32, MAX_BYTES = 16 * 1024 * 1024, LIFETIME = 5 * 60_000;
type Asset = { path: string; entryId: string; revision: string; bytes: Buffer; type: string };
type Lease = { receipt: HtmlPreviewLease; workspace: WorkspaceService; assets: Map<string, Asset>; current(): Promise<boolean>; timer: ReturnType<typeof setTimeout> };
const route = (path: string) => path.split('/').map(encodeURIComponent).join('/');
/** Serves only captured successful output files, never the surrounding project.
 * Each URL belongs to this exact worker and expires; history does not reacquire it. */
export class HtmlPreviews {
  #server?: ReturnType<typeof Bun.serve>;
  #leases = new Map<string, Lease>();
  #pending = new Set<Promise<unknown>>();
  #opening = 0;
  #disposed = false;
  #disposal?: Promise<void>;
  get active() { return this.#leases.size > 0 || this.#opening > 0; }
  async open(request: HtmlPreviewRequest, cwd: string, entries: readonly OutputEntry[], current: () => Promise<boolean>): Promise<HtmlPreviewLease> {
    if (this.#disposed || this.#leases.size + this.#opening >= 4) throw new Error('Close an existing HTML preview before opening another.');
    this.#opening++;
    const run = this.#open(request, cwd, entries, current);
    this.#pending.add(run);
    try { return await run; } finally { this.#pending.delete(run); this.#opening--; }
  }
  async #open(request: HtmlPreviewRequest, cwd: string, entries: readonly OutputEntry[], current: () => Promise<boolean>): Promise<HtmlPreviewLease> {
    const workspace = new WorkspaceService(cwd), paths = new Map<string, string>();
    // Latest successful recorded writes/edits own the bytes. No read/input path is admitted.
    for (const entry of entries.slice(-5000)) for (const path of recordedOutputFiles(entry, cwd)) paths.set(path, entry.id);
    if (paths.get(request.output.path) !== request.output.entryId) throw new Error('The original edited HTML output changed.');
    const selected = [request.output.path, ...paths.keys()].filter((path, index, all) => all.indexOf(path) === index && TYPES[extname(path).toLowerCase()]);
    if (selected.length > MAX_FILES) throw new Error('This preview exceeds the 32 recorded-file limit.');
    const assets = new Map<string, Asset>(); let total = 0;
    for (const path of selected) {
      const local = relative(workspace.cwd, path);
      if (!local || local.startsWith('../') || local === '..') continue;
      const before = await workspace.copyInfo(local), copy = await workspace.readBytes(local), after = await workspace.copyInfo(local);
      if (before.revision !== after.revision) throw new Error('A saved preview file changed during reading.');
      total += copy.bytes.length; if (total > MAX_BYTES) throw new Error('This preview exceeds the 16 MiB recorded-file limit.');
      assets.set(route(local), { path: local, entryId: paths.get(path)!, revision: before.revision, bytes: copy.bytes, type: TYPES[extname(path).toLowerCase()]! });
    }
    const original = route(relative(workspace.cwd, request.output.path));
    const stillCurrent = await current();
    if (!assets.has(original) || this.#disposed || !stillCurrent) throw new Error('The original HTML output is no longer available.');
    this.#server ??= Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => this.#request(req) });
    const leaseId = crypto.randomUUID(), expiresAt = Date.now() + LIFETIME;
    const receipt: HtmlPreviewLease = { leaseId, epoch: request.epoch, entryId: request.output.entryId, revision: request.output.revision,
      url: new URL(`/${leaseId}/${original}`, this.#server.url).href, workerPid: process.pid, expiresAt, validForMs: LIFETIME };
    const timer = setTimeout(() => this.release(leaseId), LIFETIME); timer.unref();
    this.#leases.set(leaseId, { receipt, workspace, assets, current, timer });
    return { ...receipt };
  }
  #request(request: Request): Promise<Response> {
    if (this.#pending.size >= 8) return Promise.resolve(new Response('Preview reads are busy.', { status: 429 }));
    const run = this.#serve(request); this.#pending.add(run);
    void run.then(() => this.#pending.delete(run), () => this.#pending.delete(run)); return run;
  }
  async #serve(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'" };
    const fail = (status: number) => new Response('The original saved preview is unavailable. Reopen its current Suggested output.', { status, headers });
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
    const url = new URL(request.url), [, id, ...parts] = url.pathname.split('/'), lease = this.#leases.get(id!);
    const asset = lease?.assets.get(parts.join('/'));
    if (!lease || !asset || this.#disposed || Date.now() >= lease.receipt.expiresAt) return fail(410);
    try {
      if (!await lease.current() || this.#leases.get(id!) !== lease || this.#disposed) { this.release(id!); return fail(410); }
      if ((await lease.workspace.copyInfo(asset.path)).revision !== asset.revision) { this.release(id!); return fail(410); }
      if (!await lease.current() || this.#leases.get(id!) !== lease || this.#disposed || Date.now() >= lease.receipt.expiresAt) { this.release(id!); return fail(410); }
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(asset.bytes).buffer, { headers: { ...headers, 'Content-Type': asset.type } });
    } catch { this.release(id!); return fail(410); }
  }
  release(id: string): void { const lease = this.#leases.get(id); if (!lease) return; clearTimeout(lease.timer); this.#leases.delete(id); }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true; for (const id of this.#leases.keys()) this.release(id);
    return this.#disposal = (async () => { await this.#server?.stop(true); await Promise.allSettled([...this.#pending]); })();
  }
}
