import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getSSHConfigPath } from '@oh-my-pi/pi-utils';
import { withFileLock } from '@oh-my-pi/pi-utils/file-lock';
import { loadCapability } from '@oh-my-pi/pi-coding-agent/discovery';
import { sshCapability, type SSHHost } from '@oh-my-pi/pi-coding-agent/capability/ssh';
import { clearCache } from '@oh-my-pi/pi-coding-agent/capability/fs';
import { validateHostName, writeSSHConfigFile, type SSHConfigFile } from '@oh-my-pi/pi-coding-agent/ssh/config-writer';
import type { NativeSshCatalog, NativeSshDetail, NativeSshDetailRequest, NativeSshHost, NativeSshMutation } from '@agent-desktop/shared';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unsafeKey = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (Array.isArray(value)) return value.every(item => safeTree(item, depth + 1));
  return !object(value) || (!Object.keys(value).some(unsafeKey) && Object.values(value).every(item => safeTree(item, depth + 1)));
}
function validHost(name: string, value: unknown): value is Record<string, unknown> {
  if (validateHostName(name) || !object(value) || !safeTree(value) || typeof value.host !== 'string' || !value.host.trim()) return false;
  for (const key of ['username', 'keyPath', 'description']) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  if ([value.host, value.username, value.keyPath].some(value => typeof value === 'string' && /[\0\r\n]/.test(value))) return false;
  return (value.port === undefined || typeof value.port === 'number' && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535)
    && (value.compat === undefined || typeof value.compat === 'boolean');
}
function readableLegacyHost(value: unknown): value is Record<string, unknown> {
  return object(value) && safeTree(value) && typeof value.host === 'string' && Boolean(value.host.trim());
}
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return path.join(await canonical(path.dirname(file)), path.basename(file)); }
}
/** A bounded, no-follow read. Capability discovery is deliberately not trusted
 * for ownership or mutation because it follows links and caches file contents. */
async function raw(file: string): Promise<string | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat(), limit = 1024 * 1024;
    if (!before.isFile() || before.size > limit) throw new Error('SSH configuration must be a regular file smaller than 1 MiB.');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    for (;;) { const result = await handle.read(buffer, size, buffer.length - size, null); size += result.bytesRead; if (size > limit) throw new Error('SSH configuration exceeds 1 MiB.'); if (!result.bytesRead) break; }
    const after = await handle.stat(), current = await stat(file);
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('SSH configuration changed during the read. Reload it.');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
type Parsed = { value: Record<string, unknown>; error?: string };
/** Discovery deliberately accepts legacy string port/compat and `key`; strict
 * editable-field checks happen only at detail/mutation boundaries. */
function parse(text: string | null): Parsed {
  if (text === null) return { value: { hosts: {} } };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { value: { hosts: {} }, error: 'is not valid JSON' }; }
  if (!object(value) || !safeTree(value) || (value.hosts !== undefined && (!object(value.hosts) || Object.values(value.hosts).some(host => !object(host) || !safeTree(host))))) return { value: { hosts: {} }, error: 'has an unsupported host structure' };
  return { value };
}
const id = (name: string, file: string) => createHash('sha256').update(JSON.stringify([name, file])).digest('hex');
const knownHostFields = new Set(['host', 'username', 'port', 'keyPath', 'description', 'compat']);

/** Configuration-only OMP SSH catalog. It never opens an SSH connection or
 * expands saved values before returning them to the settings UI. */
export class NativeSsh {
  private secret = randomBytes(32);
  private tail: Promise<unknown> = Promise.resolve();
  private ordered<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.catch(() => {}).then(fn); this.tail = next; return next; }
  private async inspect(cwd: string) {
    cwd = await realpath(cwd);
    const userPath = getSSHConfigPath('user', cwd), projectPath = getSSHConfigPath('project', cwd);
    const user = path.join(await canonical(path.dirname(userPath)), path.basename(userPath));
    const project = path.join(await canonical(path.dirname(projectPath)), path.basename(projectPath));
    const legacy = [path.join(cwd, 'ssh.json'), path.join(cwd, '.ssh.json')].map(file => path.join(path.dirname(file), path.basename(file)));
    const files = new Set([user, project, ...legacy]);
    const sources = await Promise.all([...files].map(async file => [file, await raw(file)] as const));
    const captured = new Map(sources);
    const parsed = new Map(sources.map(([file, text]) => [file, parse(text)]));
    const warnings = sources.flatMap(([file]) => parsed.get(file)!.error ? [`SSH configuration ${file} ${parsed.get(file)!.error}.`] : []);
    clearCache();
    const discovered = await loadCapability<SSHHost>(sshCapability.id, { cwd });
    if (discovered.warnings.length) warnings.push('An SSH configuration source contains invalid entries.');
    const rows: Array<{ host: NativeSshHost; file: string; writable: boolean }> = [];
    for (const item of discovered.all) {
      const source = path.join(await canonical(path.dirname(item._source.path)), path.basename(item._source.path));
      files.add(source);
      if (!parsed.has(source)) { const text = await raw(source); captured.set(source, text); parsed.set(source, parse(text)); }
      if (rows.some(row => row.host.id === id(item.name, source))) continue;
      const writable = source === user || source === project;
      rows.push({ file: source, writable, host: { id: id(item.name, source), name: item.name, scope: item._source.level === 'user' ? 'user' : 'project', source: item._source.providerName ?? 'OMP', shadowed: Boolean(item._shadowed), editable: writable } });
    }
    // Include valid managed rows even when the runtime's active catalog filters
    // them; legacy files remain read-only regardless of their contents.
    for (const [file, scope] of [[project, 'project'], [user, 'user']] as const) {
      const value = parsed.get(file)!;
      if (value.error) continue;
      for (const name of Object.keys(value.value.hosts as Record<string, unknown> ?? {})) {
        if (rows.some(row => row.host.id === id(name, file))) continue;
        rows.push({ file, writable: true, host: { id: id(name, file), name, scope, source: 'OMP', shadowed: rows.some(row => row.host.name === name && !row.host.shadowed), editable: true } });
      }
    }
    const fingerprints = await Promise.all([...files].sort().map(async file => [file, await raw(file)] as const));
    if (fingerprints.some(([file, text]) => captured.get(file) !== text)) throw new Error('SSH configuration changed during discovery. Reload it.');
    const snapshot: NativeSshCatalog = { revision: createHmac('sha256', this.secret).update(JSON.stringify([cwd, fingerprints, rows.map(row => row.host)])).digest('hex'), hosts: rows.map(row => row.host).sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)), warnings: [...new Set(warnings)] };
    return { snapshot, rows, user, project, parsed, fingerprints };
  }
  read(cwd: string): Promise<NativeSshCatalog> { return this.ordered(async () => (await this.inspect(cwd)).snapshot); }
  detail(cwd: string, request: NativeSshDetailRequest): Promise<NativeSshDetail> { return this.ordered(async () => {
    const observed = await this.inspect(cwd);
    if (observed.snapshot.revision !== request.expectedRevision) throw new Error('SSH configuration changed. Reload before editing.');
    const selected = observed.rows.find(row => row.host.id === request.hostId);
    if (!selected) throw new Error('The selected SSH host no longer exists.');
    const owner = observed.parsed.get(selected.file)!;
    const config = owner.value.hosts as Record<string, unknown> | undefined;
    const rawHost = config?.[selected.host.name];
    if (owner.error || !config || !(selected.writable ? validHost(selected.host.name, rawHost) : readableLegacyHost(rawHost))) throw new Error('The original SSH host is no longer valid. Repair its configuration before viewing.');
    return { revision: observed.snapshot.revision, host: selected.host, config: structuredClone(config[selected.host.name]) as Record<string, unknown> };
  }); }
  mutate(cwd: string, mutation: NativeSshMutation): Promise<NativeSshCatalog> { return this.ordered(async () => {
    const observed = await this.inspect(cwd);
    if (observed.snapshot.revision !== mutation.expectedRevision) throw new Error('SSH configuration changed. Reload before saving.');
    const selected = mutation.operation === 'add' ? undefined : observed.rows.find(row => row.host.id === mutation.hostId);
    if (mutation.operation !== 'add' && !selected) throw new Error('The selected SSH host no longer exists.');
    if (selected && !selected.writable) throw new Error('This SSH host is owned by another configuration source and cannot be edited here.');
    const writeFile = mutation.operation === 'add' ? mutation.scope === 'user' ? observed.user : observed.project : selected!.file;
    const locks = [writeFile].sort();
    const lock = async <T>(index: number, fn: () => Promise<T>): Promise<T> => index === locks.length ? fn() : (await mkdir(path.dirname(locks[index]!), { recursive: true, mode: 0o700 }), withFileLock(locks[index]!, () => lock(index + 1, fn)));
    return lock(0, async () => {
      const current = await this.inspect(cwd);
      if (current.snapshot.revision !== mutation.expectedRevision) throw new Error('SSH configuration changed. Reload before saving.');
      if (await canonical(writeFile) !== writeFile) throw new Error('SSH configuration ownership changed. Reload before saving.');
      const owner = current.parsed.get(writeFile);
      if (!owner || owner.error) throw new Error('The target SSH configuration must be repaired before saving.');
      const target = structuredClone(owner.value) as Record<string, unknown>, hosts = (target.hosts ??= {}) as Record<string, unknown>;
      if (mutation.operation === 'add') {
        if (!validHost(mutation.name, mutation.config)) throw new Error('Enter a valid SSH host name and configuration.');
        if (Object.hasOwn(hosts, mutation.name)) throw new Error('An SSH host with that name already exists in this scope.');
        hosts[mutation.name] = structuredClone(mutation.config);
      } else if (mutation.operation === 'update') {
        const name = selected!.host.name;
        if (!Object.hasOwn(hosts, name)) throw new Error('The original SSH host is no longer present.');
        if (!validHost(name, mutation.config)) throw new Error('The SSH host configuration is invalid.');
        const original = hosts[name] as Record<string, unknown>;
        const opaque = Object.fromEntries(Object.entries(original).filter(([key]) => !knownHostFields.has(key)));
        hosts[name] = { ...opaque, ...structuredClone(mutation.config) };
      } else {
        const name = selected!.host.name;
        if (!Object.hasOwn(hosts, name)) throw new Error('The original SSH host is no longer present.');
        delete hosts[name];
      }
      if (Buffer.byteLength(JSON.stringify(target, null, 2), 'utf8') > 1024 * 1024) throw new Error('SSH configuration would exceed 1 MiB.');
      // OMP's writer has a fixed `${file}.tmp`. Give it a private, freshly
      // created sibling directory, then atomically install its completed file.
      // This cannot follow a pre-existing owner `.tmp` symlink.
      const tempDir = await mkdtemp(path.join(path.dirname(writeFile), '.agent-ssh-'));
      const tempOwner = path.join(tempDir, path.basename(writeFile));
      try {
        await writeSSHConfigFile(tempOwner, target as SSHConfigFile);
        const fingerprint = current.fingerprints.find(([file]) => file === writeFile)?.[1];
        if (fingerprint === undefined || await raw(writeFile) !== fingerprint || await canonical(writeFile) !== writeFile) throw new Error('SSH configuration ownership changed. Reload before saving.');
        await rename(tempOwner, writeFile);
      } finally { await rm(tempDir, { recursive: true, force: true }); }
      clearCache();
      return (await this.inspect(cwd)).snapshot;
    });
  }); }
}
