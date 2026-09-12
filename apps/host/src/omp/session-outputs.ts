import { fileURLToPath } from 'node:url';
import { outputDocumentLinks, declaredWebsite } from './output-links';
import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_SESSION_OUTPUTS, parseSessionOutputs, sessionOutputKey, type SessionOutput, type SessionOutputs } from '@agent-desktop/shared';
import { nativeMcpArtifact } from './mcp-artifacts';
import { readNativeImage, type OmpRecordedImage } from './images';
export interface OutputEntry { id: string; type?: string; message?: unknown }
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sessionOutputBranch = (entries: readonly OutputEntry[]) => hash(entries.map(entry => entry.id));
const fileExtensions = new Set('avif csv doc docx gif jpeg jpg md mdx pdf png ppt pptx tsv webp xls xlsm xlsx'.split(' '));
const documentExtensions = new Set(['.docx', '.pdf', '.pptx', '.xlsx']);
function outputPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\0-\x1f\x7f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return;
  const path = resolve(cwd, value);
  if (['work', '.codex_scratch'].some(part => path === resolve(cwd, part) || path.startsWith(`${resolve(cwd, part)}/`))) return;
  return path;
}
function successful(message: Record<string, unknown>) { return message.role === 'toolResult' && message.isError === false; }
function generatedDetails(message: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!successful(message)) return;
  const details = record(message.details), dispatch = record(details?.xdev);
  if (message.toolName === 'generate_image') return details;
  return dispatch?.mode === 'execute' && dispatch.tool === 'generate_image' ? record(dispatch.inner) : undefined;
}
/** Successful native output metadata only. Requested paths, preview edits and
 * input reads do not grant a file to the preview server. */
export function recordedOutputFiles(entry: OutputEntry, cwd: string): string[] {
  const message = record(entry.message);
  if (!message || !successful(message)) return [];
  const details = record(message.details), dispatch = record(details?.xdev);
  const name = dispatch?.mode === 'execute' ? dispatch.tool : message.toolName;
  const value = dispatch?.mode === 'execute' ? record(dispatch.inner) : details;
  let paths: unknown[] = [];
  if (name === 'write') paths = [value?.resolvedPath];
  if (name === 'edit') {
    const files = Array.isArray(value?.perFileResults) ? value.perFileResults : [value];
    paths = files.flatMap(raw => { const f = record(raw); return f && ['create', 'update'].includes(String(f.op)) ? [f.path] : []; });
  }
  if (name === 'ast_edit' && value?.applied === true && Array.isArray(value.fileReplacements)) {
    paths = value.fileReplacements.flatMap(raw => { const f = record(raw); return f && typeof f.count === 'number' && f.count > 0 ? [f.path] : []; });
  }
  if (name === 'generate_image' && Array.isArray(value?.imagePaths)) paths = value.imagePaths;
  return [...new Set(paths.map(value => outputPath(cwd, value)).filter((p): p is string => p !== undefined))];
}
/** This namespace addresses retained generated output bytes, never an arbitrary path
 * or a content-block index from an input image. */
export function recordedGeneratedImage(entry: OutputEntry | undefined, index: number): OmpRecordedImage {
  const message = record(entry?.message), details = message && generatedDetails(message);
  if (!Number.isSafeInteger(index) || index < 0 || index >= 100 || !details || !Array.isArray(details.images)
    || !Array.isArray(details.imagePaths) || typeof details.imagePaths[index] !== 'string') throw new Error('The saved generated image is unavailable.');
  const image = record(details.images[index]);
  return readNativeImage({ ...image, type: 'image' });
}
function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.flatMap(raw => { const b = record(raw); return b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []; }).join('\n') : '';
}
/** Pinned reference distinguishes explicit outputs from source/read mentions.
 * OMP supplies successful-write and image-generation metadata directly. */
export function projectSessionOutputs(entries: readonly OutputEntry[], cwd: string): { outputs: SessionOutput[]; warnings: string[]; truncated: boolean } {
  const warnings = new Set<string>(), branch = sessionOutputBranch(entries);
  type Generated = { entryId: string; turnId: string; revision: string; label: string; kind: 'generated-image'; path: string; imageIndex: number; entry: OutputEntry };
  type Candidate = Exclude<SessionOutput, { kind: 'generated-image' }> | Generated;
  type Turn = { id: string; outputs: Candidate[]; reads: Set<string>; html: Map<string, Candidate>; final?: { entry: OutputEntry; text: string }; complete: boolean };
  const turns: Turn[] = []; let turn: Turn | undefined;
  const calls = new Map<string, Record<string, unknown>>();
  for (const entry of entries.slice(-5000)) {
    const m = record(entry.message); if (!m) continue;
    if (m.role === 'user') { turn = { id: entry.id, outputs: [], reads: new Set(), html: new Map(), complete: false }; turns.push(turn); calls.clear(); }
    if (!turn) continue;
    if (Array.isArray(m.content)) for (const raw of m.content) { const c = record(raw); if (c?.type === 'toolCall' && typeof c.id === 'string') calls.set(c.id, c); }
    if (m.role === 'fileMention' && Array.isArray(m.files)) for (const raw of m.files) { const f = record(raw), path = outputPath(cwd, f?.path); if (path) turn.reads.add(path); }
    if (m.role === 'assistant') {
      turn.complete = m.stopReason === 'stop' || m.stopReason === 'length';
      turn.final = { entry, text: messageText(m) };
    }
    if (!successful(m)) continue;
    const base = { entryId: entry.id, turnId: turn.id, revision: hash([entry.id, turn.id]) };
    const details = record(m.details), call = calls.get(String(m.toolCallId)), args = record(call?.arguments);
    if (m.toolName === 'read') { const path = outputPath(cwd, details?.resolvedPath ?? args?.path); if (path) turn.reads.add(path); }
    for (const path of recordedOutputFiles(entry, cwd)) {
      if (/\.html?$/i.test(path)) turn.html.set(path, { ...base, kind: 'html-preview', path, branch, label: basename(path) });
    }
    if (m.toolName === 'write' && !details?.xdev) {
      const path = outputPath(cwd, details?.resolvedPath);
      if (path && fileExtensions.has(extname(path).slice(1).toLowerCase())) turn.outputs.push({ ...base, kind: 'file', path, label: basename(path) });
    }
    const generated = generatedDetails(m);
    if (generated && Array.isArray(generated.imagePaths)) for (let index = 0; index < Math.min(generated.imagePaths.length, 100); index++) {
      const path = outputPath(cwd, generated.imagePaths[index]); if (!path) continue;
      turn.outputs.push({ ...base, kind: 'generated-image', path, label: basename(path), imageIndex: index, entry });
    }
    try { const artifact = nativeMcpArtifact(entry.id, m); if (artifact && artifact.result.isError !== true) turn.outputs.push({ ...base, kind: 'mcp', revision: hash([entry.id, artifact]), label: `${artifact.toolName} result`.slice(0, 1000), serverName: artifact.serverName, toolName: artifact.toolName, resourceUri: artifact.resourceUri }); }
    catch { warnings.add('Some saved app outputs are unavailable; their tools were not replayed.'); }
  }
  const selected: Candidate[] = [], seen = new Map<string, number>();
  for (const turn of turns.reverse()) {
    if (turn.complete && turn.final) {
      for (let target of outputDocumentLinks(turn.final.text)) {
        try { target = target.startsWith('file://') ? fileURLToPath(target) : decodeURI(target); } catch { continue; }
        const path = outputPath(cwd, target);
        if (path && documentExtensions.has(extname(path).toLowerCase()) && !turn.reads.has(path)) turn.outputs.push({ kind: 'file', path, label: basename(path), entryId: turn.final.entry.id, turnId: turn.id, revision: hash([turn.final.entry.id, path]) });
      }
      const website = declaredWebsite(turn.final.text);
      if (!turn.outputs.some(o => o.kind === 'file' || o.kind === 'mcp')) {
        if (website) turn.outputs.push({ kind: 'website', url: website, label: website.slice(0, 1000), entryId: turn.final.entry.id, turnId: turn.id, revision: hash([turn.final.entry.id, website]) });
        else if (turn.html.size === 1) turn.outputs.push(turn.html.values().next().value!);
      }
    }
    // A generated image is an already completed output even during the next text step.
    for (const output of [...turn.outputs.filter(value => value.kind === 'mcp'), ...turn.outputs.filter(value => value.kind === 'generated-image').reverse(), ...turn.outputs.filter(value => value.kind !== 'generated-image' && value.kind !== 'mcp')]) {
      if (!turn.complete && output.kind !== 'generated-image') continue;
      const key = output.kind === 'generated-image' ? `path:${output.path}` : sessionOutputKey(output), index = seen.get(key);
      if (index !== undefined) { if (selected[index]?.kind === 'file' && output.kind === 'generated-image') selected[index] = output; continue; }
      seen.set(key, selected.length); selected.push(output);
    }
  }
  const outputs: SessionOutput[] = [];
  // Decode only the bounded selected images, never every image in retained history.
  for (const candidate of selected.slice(0, MAX_SESSION_OUTPUTS)) {
    if (candidate.kind !== 'generated-image') { outputs.push(candidate); continue; }
    try {
      const { entry, ...output } = candidate;
      const { data: _, ...image } = recordedGeneratedImage(entry, output.imageIndex);
      const mimeType = IMAGE_ATTACHMENT_MIME_TYPES.find(value => value === image.mimeType);
      if (!mimeType) throw new Error('Unsupported saved image type.');
      outputs.push({ ...output, ...image, mimeType, revision: hash([entry.id, output.imageIndex, image.sha256]) });
    } catch { warnings.add('Some saved generated images are unavailable; no images were regenerated.'); }
  }
  return { outputs, warnings: [...warnings], truncated: selected.length > MAX_SESSION_OUTPUTS || entries.length > 5000 };
}
/** Only already selected output paths are inspected; no directory scanning or tool execution. */
export async function inspectSessionOutputs(entries: readonly OutputEntry[], cwd: string, epoch: string): Promise<SessionOutputs> {
  const projected = projectSessionOutputs(entries, cwd), outputs: SessionOutput[] = [];
  for (const output of projected.outputs) {
    if (output.kind !== 'file' && output.kind !== 'html-preview' && output.kind !== 'generated-image') { outputs.push(output); continue; }
    try {
      const path = await realpath(output.path), file = await stat(path, { bigint: true });
      if (!file.isFile()) continue;
      outputs.push({ ...output, revision: hash([output.revision, path, String(file.dev), String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]) });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(String((error as { code?: string }).code))) continue;
      throw new Error(`The saved output could not be checked: ${output.label}`, { cause: error });
    }
  }
  return parseSessionOutputs({ ...projected, outputs, epoch, revision: hash(outputs) });
}
