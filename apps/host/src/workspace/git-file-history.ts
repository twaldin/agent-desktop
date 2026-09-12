import { createHash } from "node:crypto";
import type { FileContent } from "../../../../packages/shared/src/workspace";
import { parseGitFileLocation, type GitFileBlameLine, type GitFileCommit, type GitFileHistoryPage, type GitFileLocation, type GitFileOrigin, type GitFileRevision } from "../../../../packages/shared/src/git-file-history";
import { WorkspaceError } from "./service";

export interface GitFileReadIO {
  text(args: string[]): Promise<string>;
  bytes(args: string[]): Promise<Buffer>;
  maximumBytes: number;
}
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
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
    if (!header || !oid.test(header[1]!)) throw invalid();
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

/** NUL framing preserves whitespace/newlines in paths and commit metadata. */
export function parseFileHistory(output: string, initialPath: string): GitFileCommit[] {
  const fields = output.split("\0"), rows: GitFileCommit[] = [];
  let index = 0, path = initialPath;
  while (index < fields.length) {
    while (fields[index] === "" || fields[index] === "\n") index++;
    if (index >= fields.length) break;
    if (fields[index++] !== "GIT_FILE_COMMIT") throw invalid();
    const commit = fields[index++]!, parents = fields[index++]!, author = fields[index++]!, email = fields[index++]!, time = fields[index++]!, summary = fields[index++]!;
    if (!oid.test(commit) || parents && !parents.split(" ").every(parent => oid.test(parent)) || !/^-?\d+$/.test(time) || !Number.isSafeInteger(Number(time))) throw invalid();
    while (fields[index] === "") index++;
    const change = fields[index++]?.replace(/^\n/, "");
    if (!change || !/^(?:[AMDTUXB]|[RC]\d+)$/.test(change)) throw invalid();
    const first = fields[index++]!;
    const renamed = /^[RC]/.test(change), current = renamed ? fields[index++]! : first;
    if (current !== path) throw invalid();
    const parent = parents.split(" ")[0];
    const previous = parent && change !== "A" ? { commit: parent, path: renamed ? first : path } : null;
    rows.push({ commit, path, author, email, authorTime: Number(time), summary, change, previous });
    if (renamed) path = first;
  }
  return rows;
}

/** All commands are bounded, local-object-only reads; no checkout, filters, textconv or network. */
export class GitFileReader {
  constructor(private io: GitFileReadIO) {}
  async history(origin: GitFileOrigin, input: GitFileLocation): Promise<GitFileHistoryPage> {
    const start = parseGitFileLocation(input);
    const output = await this.io.text(["log", "--first-parent", "--follow", "--no-decorate", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--format=%x00GIT_FILE_COMMIT%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00", "--name-status", "-z", "--max-count=101", start.commit, "--", start.path]);
    const all = parseFileHistory(output, start.path), commits = all.slice(0, 100);
    return { origin, start, commits, next: all.length > 100 ? commits.at(-1)!.previous : null, traversal: "first-parent" };
  }
  async revision(origin: GitFileOrigin, input: GitFileLocation): Promise<GitFileRevision> {
    const location = parseGitFileLocation(input);
    const tree = await this.io.text(["ls-tree", "-z", location.commit, "--", location.path]);
    if (!tree) return { origin, location, content: null, blame: [], blameUnavailable: "This path does not exist at this commit (it may have been deleted or renamed)." };
    const match = /^(\d+) (\S+) ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
    if (!match || match[4] !== location.path || !oid.test(match[3]!)) throw invalid();
    if (match[2] !== "blob" || !/^100[0-7]{3}$/.test(match[1]!)) return { origin, location, content: null, blame: [], blameUnavailable: "Only regular Git blobs support source history (not directories, symlinks or submodules)." };
    const size = Number((await this.io.text(["cat-file", "-s", match[3]!])).trim());
    const authorTime = Number((await this.io.text(["show", "--no-patch", "--format=%at", "--no-show-signature", location.commit, "--"])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(authorTime)) throw invalid();
    const metadata = { path: location.path, size, modifiedAt: authorTime * 1000, mode: parseInt(match[1]!, 8) & 0o777 };
    if (size > this.io.maximumBytes) return { origin, location, content: { ...metadata, kind: "too-large", revision: null, maximumBytes: this.io.maximumBytes }, blame: [], blameUnavailable: "This revision exceeds the host text limit." };
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
    if (content.kind !== "text") return { origin, location, content, blame: [], blameUnavailable: content.kind === "binary" ? "Binary revisions do not have text blame." : "This revision's encoding is unsupported." };
    const blame = content.text.length ? parseFileBlame(await this.io.text(["-c", "core.quotePath=false", "blame", "--no-textconv", "--line-porcelain", "--root", location.commit, "--", location.path])) : [];
    return { origin, location, content, blame };
  }
}
