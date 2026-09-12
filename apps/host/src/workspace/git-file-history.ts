import { createHash } from "node:crypto";
import type { FileContent } from "../../../../packages/shared/src/workspace";
import { gitObjectId, parseGitFileHistoryCursor, parseGitFileLocation, parseGitFilePath, type GitFileBlameLine, type GitFileChange, type GitFileCommit, type GitFileHistoryCursor, type GitFileHistoryPage, type GitFileLocation, type GitFileOrigin, type GitFileRevision } from "../../../../packages/shared/src/git-file-history";
import { WorkspaceError } from "./service";

export interface GitFileReadIO {
  text(args: string[], input?: string): Promise<string>;
  bytes(args: string[]): Promise<Buffer>;
  maximumBytes: number;
}
const historyPageSize = 100;
const invalid = () => new WorkspaceError("INVALID_GIT_OUTPUT", "Git returned invalid file history or blame metadata.");

/** Git C-quotes unusual filenames, even with core.quotePath=false. */
function blamePath(input: string): string {
  if (!input.startsWith('"')) return input;
  if (!input.endsWith('"')) throw invalid();
  const bytes: number[] = [];
  for (let index = 1; index < input.length - 1;) {
    const char = input[index++]!;
    if (char !== "\\") {
      const point = input.codePointAt(index - 1)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) index++;
      continue;
    }
    const escape = input[index++]!;
    if (/[0-7]/.test(escape)) {
      const octal = escape + input.slice(index, index + 2);
      if (!/^[0-7]{3}$/.test(octal)) throw invalid();
      bytes.push(parseInt(octal, 8)); index += 2;
    } else {
      const value = ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 } as Record<string, number>)[escape];
      if (value === undefined) throw invalid();
      bytes.push(value);
    }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)); } catch { throw invalid(); }
}

export function parseFileBlame(output: string): GitFileBlameLine[] {
  const lines = output.split("\n"), result: GitFileBlameLine[] = [];
  for (let index = 0; index < lines.length && lines[index] !== "";) {
    const header = /^(\S+) (\d+) (\d+)(?: \d+)?$/.exec(lines[index++]!);
    if (!header || !gitObjectId.test(header[1]!)) throw invalid();
    const metadata = new Map<string, string>();
    while (index < lines.length && !lines[index]!.startsWith("\t")) {
      const row = lines[index++]!, space = row.indexOf(" ");
      metadata.set(space < 0 ? row : row.slice(0, space), space < 0 ? "" : row.slice(space + 1));
    }
    if (index >= lines.length || !metadata.has("filename") || !metadata.has("author") || !metadata.has("author-mail") || !metadata.has("author-time")) throw invalid();
    index++;
    const originalLine = Number(header[2]), line = Number(header[3]), authorTime = Number(metadata.get("author-time"));
    if (!Number.isSafeInteger(originalLine) || originalLine < 1 || line !== result.length + 1 || !Number.isSafeInteger(authorTime)) throw invalid();
    result.push({ line, originalLine, commit: header[1]!, path: blamePath(metadata.get("filename")!), author: metadata.get("author")!, email: metadata.get("author-mail")!, authorTime, summary: metadata.get("summary") ?? "" });
  }
  return result;
}

interface HistoryCommit {
  commit: string; parents: string[]; author: string; email: string; authorTime: number; summary: string;
}
interface HistoryChange { change: GitFileChange; previousPath: string }

function historyMetadata(output: string): HistoryCommit[] {
  const fields = output.split("\0"), commits: HistoryCommit[] = [];
  for (let index = 0; index < fields.length;) {
    if (fields[index] === "" || fields[index] === "\n") { index++; continue; }
    const commit = fields[index++]!, parentText = fields[index++]!, author = fields[index++]!, email = fields[index++]!, time = fields[index++]!, summary = fields[index++];
    const parents = parentText ? parentText.split(" ") : [];
    if (!gitObjectId.test(commit) || !parents.every(parent => gitObjectId.test(parent)) || !/^-?\d+$/.test(time) || !Number.isSafeInteger(Number(time)) || summary === undefined) throw invalid();
    commits.push({ commit, parents, author, email, authorTime: Number(time), summary });
  }
  return commits;
}

/** diff-tree echoes non-object input lines. Only recognize frames at status boundaries,
 * never inside NUL-framed filenames (which may contain newlines or marker text). */
function historyChanges(output: string, count: number): Map<string, HistoryChange>[] {
  let offset = 0;
  const token = () => {
    const end = output.indexOf("\0", offset);
    if (end < 0) throw invalid();
    const value = output.slice(offset, end); offset = end + 1; return value;
  };
  const changes: Map<string, HistoryChange>[] = [];
  for (let index = 0; index < count; index++) {
    const marker = `GIT_FILE_EDGE_${index}\n`, next = `GIT_FILE_EDGE_${index + 1}\n`;
    if (!output.startsWith(marker, offset)) throw invalid();
    offset += marker.length;
    const entries = new Map<string, HistoryChange>();
    while (!output.startsWith(next, offset)) {
      const change = token();
      if (!/^(?:[AMDTUXB]|[RC]\d+)$/.test(change)) throw invalid();
      const previousPath = token(), path = /^[RC]/.test(change) ? token() : previousPath;
      entries.set(path, { change: change as GitFileChange, previousPath });
    }
    changes.push(entries);
  }
  if (output.slice(offset) !== `GIT_FILE_EDGE_${count}\n`) throw invalid();
  return changes;
}

/** All commands are bounded, local-object-only reads; no checkout, filters, textconv or network. */
export class GitFileReader {
  constructor(private io: GitFileReadIO) {}
  async history(origin: GitFileOrigin, input: GitFileHistoryCursor): Promise<GitFileHistoryPage> {
    const start = parseGitFileHistoryCursor(input);
    // Git orders children before every parent, then by commit date. Unlike --follow,
    // skipping this unfiltered metadata scan cannot discard rename discoveries.
    const metadata = historyMetadata(await this.io.text(["log", "--date-order", "--no-decorate", "--no-show-signature", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00", "-z", `--skip=${start.offset}`, `--max-count=${historyPageSize + 1}`, start.commit, "--"]));
    const page = metadata.slice(0, historyPageSize), edges: string[] = [];
    for (const row of page) for (const parent of row.parents.length ? row.parents : [null]) {
      edges.push(`GIT_FILE_EDGE_${edges.length}\n${row.commit}${parent ? ` ${parent}` : ""}\n`);
    }
    // Never silently skip modified renames due to repository renameLimit; host time/output limits still apply.
    const changes = edges.length ? historyChanges(await this.io.text(["diff-tree", "--stdin", "--no-commit-id", "--root", "-r", "-M", "-l0", "--no-ext-diff", "--no-textconv", "--name-status", "-z"], edges.join("") + `GIT_FILE_EDGE_${edges.length}\n`), edges.length) : [];
    const pending = new Map<string, Set<string>>();
    const enqueue = (commit: string, path: string) => {
      const paths = pending.get(commit);
      if (paths) paths.add(path); else pending.set(commit, new Set([path]));
    };
    for (const location of start.pending) enqueue(location.commit, location.path);
    const commits: GitFileCommit[] = [];
    let edge = 0;
    for (const row of page) {
      const paths = pending.get(row.commit);
      pending.delete(row.commit);
      if (paths) for (const path of paths) {
        let displayed: { change: GitFileChange; previous: GitFileLocation | null } | undefined;
        for (let index = 0; index < Math.max(1, row.parents.length); index++) {
          const change = changes[edge + index]!.get(path), parent = row.parents[index];
          const previousPath = change ? parseGitFilePath(change.previousPath) : path;
          if (parent) enqueue(parent, previousPath);
          // The label and Before link describe this exact edge, including non-first parents.
          if (change && !displayed) displayed = { change: change.change, previous: parent && change.change !== "A" ? { commit: parent, path: previousPath } : null };
        }
        if (displayed) commits.push({ commit: row.commit, path, author: row.author, email: row.email, authorTime: row.authorTime, summary: row.summary, ...displayed });
      }
      edge += Math.max(1, row.parents.length);
    }
    const frontier = [...pending].flatMap(([commit, paths]) => [...paths].map(path => ({ commit, path })));
    return { origin, start, commits, next: metadata.length > page.length && frontier.length ? { commit: start.commit, path: start.path, offset: start.offset + page.length, pending: frontier } : null };
  }
  async revision(origin: GitFileOrigin, input: GitFileLocation): Promise<GitFileRevision> {
    const location = parseGitFileLocation(input);
    const tree = await this.io.text(["ls-tree", "-z", location.commit, "--", location.path]);
    if (!tree) return { origin, location, content: null, blame: [], blameUnavailable: "missing" };
    const match = /^(\d+) (\S+) ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
    if (!match || match[4] !== location.path || !gitObjectId.test(match[3]!)) throw invalid();
    if (match[2] !== "blob" || !/^100[0-7]{3}$/.test(match[1]!)) return { origin, location, content: null, blame: [], blameUnavailable: "not-regular-file" };
    const size = Number((await this.io.text(["cat-file", "-s", match[3]!])).trim());
    const authorTime = Number((await this.io.text(["show", "--no-patch", "--format=%at", "--no-show-signature", location.commit, "--"])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(authorTime)) throw invalid();
    const metadata = { path: location.path, size, modifiedAt: authorTime * 1000, mode: parseInt(match[1]!, 8) & 0o777 };
    if (size > this.io.maximumBytes) return { origin, location, content: { ...metadata, kind: "too-large", revision: null, maximumBytes: this.io.maximumBytes }, blame: [], blameUnavailable: "too-large" };
    const bytes = await this.io.bytes(["cat-file", "blob", match[3]!]);
    if (bytes.length !== size) throw invalid();
    const revision = createHash("sha256").update(bytes).digest("hex");
    const encoding = bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])) ? "utf32le" : bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255])) ? "utf32be"
      : bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf16be" : undefined;
    let content: FileContent;
    if (encoding) content = { ...metadata, kind: "unsupported-encoding", revision, encoding };
    else {
      let text: string | undefined;
      if (!bytes.includes(0)) try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* Invalid UTF-8 remains binary, never lossy source. */ }
      content = text === undefined ? { ...metadata, kind: "binary", revision } : { ...metadata, kind: "text", revision, text, encoding: "utf8", bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) };
    }
    if (content.kind !== "text") return { origin, location, content, blame: [], blameUnavailable: content.kind };
    const blame = content.text.length ? parseFileBlame(await this.io.text(["-c", "core.quotePath=false", "blame", "--no-textconv", "--line-porcelain", "--root", location.commit, "--", location.path])) : [];
    return { origin, location, content, blame };
  }
}
