import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, basename } from "node:path";
import { promisify } from "node:util";
import type { ComposerActionsCatalog, NativeSkillFileDocument, NativeSkillFileRef, NativeSkillFileWriteResult, NativeSkillInventory, TextDocument, WorkspaceTarget } from "@agent-desktop/shared";
import type { WorkerRuntime } from "./omp-workers";
import { WorkspaceService } from "./workspace";

const execute = promisify(execFile);

export class SkillFileError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_SKILL_FILE_REQUEST") { super(message); this.name = "SkillFileError"; }
}

type Catalog = Pick<ComposerActionsCatalog | NativeSkillInventory, "cwd" | "revision" | "skills">;
type Binding = {
  ref: NativeSkillFileRef;
  cwd: string;
  catalogRevision: string;
  canonicalPath: string;
  parent: { path: string; dev: number; ino: number };
  workspace: WorkspaceService;
  relativePath: string;
};
export interface SkillFileAuthorization {
  version: 1; ref: NativeSkillFileRef; cwd: string; canonicalPath: string;
  parent: { path: string; dev: number; ino: number };
}

export class SkillFiles {
  constructor(private options: {
    hostId: string;
    resolveCwd(target?: WorkspaceTarget): string;
    runtime: Pick<WorkerRuntime, "getComposerActions" | "getSkillInventory">;
    reveal?: (canonicalPath: string) => Promise<void>;
    authorizations?: { get(ref: NativeSkillFileRef): SkillFileAuthorization | undefined; put(ref: NativeSkillFileRef, value: SkillFileAuthorization): void };
  }) {}

  private async catalog(ref: NativeSkillFileRef): Promise<Catalog> {
    const cwd = this.resolveCwd(ref.target);
    const value = ref.inventory
      ? await this.options.runtime.getSkillInventory(cwd, { refresh: true })
      : await this.options.runtime.getComposerActions(cwd, { refresh: true });
    if (value.cwd !== cwd || this.resolveCwd(ref.target) !== cwd) throw new SkillFileError("The selected skill owner changed. Refresh its inventory.", 409, "STALE_TARGET");
    return value;
  }

  private resolveCwd(target?: WorkspaceTarget): string {
    try { return this.options.resolveCwd(target); }
    catch { throw new SkillFileError("The selected skill owner no longer exists on this host.", 409, "STALE_TARGET"); }
  }

  private skillPath(catalog: Catalog, ref: NativeSkillFileRef): string | undefined {
    const matches = catalog.skills.filter(item => item.id === ref.skillId && item.source.kind === "skill" && item.source.path === ref.sourcePath);
    if (matches.length > 1) throw new SkillFileError("The native skill file identity is ambiguous. Refresh its inventory.", 409, "SKILL_FILE_CHANGED");
    return matches[0]?.source.path;
  }

  private async bind(ref: NativeSkillFileRef): Promise<Binding> {
    const catalog = await this.catalog(ref), sourcePath = this.skillPath(catalog, ref);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(ref.sourcePath);
      if (!(await lstat(canonicalPath)).isFile()) throw new Error();
    } catch { throw new SkillFileError("The native skill file is unavailable.", 404, "SKILL_FILE_UNAVAILABLE"); }
    const parent = dirname(canonicalPath);
    const parentMetadata = await stat(parent);
    const saved = this.options.authorizations?.get(ref);
    if (saved) {
      if (saved.version !== 1 || JSON.stringify(saved.ref) !== JSON.stringify(ref) || saved.cwd !== catalog.cwd || saved.canonicalPath !== canonicalPath
        || saved.parent.path !== parent || saved.parent.dev !== parentMetadata.dev || saved.parent.ino !== parentMetadata.ino) {
        throw new SkillFileError("The opened native skill file changed path identity. Open its current catalog resource explicitly.", 409, "SKILL_FILE_CHANGED");
      }
    } else if (sourcePath) {
      this.options.authorizations?.put(ref, { version: 1, ref, cwd: catalog.cwd, canonicalPath, parent: { path: parent, dev: parentMetadata.dev, ino: parentMetadata.ino } });
    } else throw new SkillFileError("The native skill file no longer matches the current catalog or an opened file on this host.", 409, "SKILL_FILE_CHANGED");
    return { ref, cwd: catalog.cwd, catalogRevision: catalog.revision, canonicalPath,
      parent: { path: parent, dev: parentMetadata.dev, ino: parentMetadata.ino },
      workspace: new WorkspaceService(parent, { maxTextBytes: 1024 * 1024 }), relativePath: basename(canonicalPath) };
  }

  private async rebind(binding: Binding, requireCatalogRevision: boolean): Promise<Catalog> {
    const catalog = await this.catalog(binding.ref);
    const sourcePath = this.skillPath(catalog, binding.ref);
    let canonicalPath: string;
    try { canonicalPath = await realpath(binding.ref.sourcePath); }
    catch { throw new SkillFileError("The native skill file is unavailable.", 404, "SKILL_FILE_UNAVAILABLE"); }
    const parent = dirname(canonicalPath), parentMetadata = await stat(parent);
    const saved = this.options.authorizations?.get(binding.ref);
    const authorized = saved?.version === 1 && JSON.stringify(saved.ref) === JSON.stringify(binding.ref) && saved.cwd === binding.cwd
      && saved.canonicalPath === binding.canonicalPath && saved.parent.path === parent && saved.parent.dev === parentMetadata.dev && saved.parent.ino === parentMetadata.ino;
    const sameParent = binding.parent.path === parent && binding.parent.dev === parentMetadata.dev && binding.parent.ino === parentMetadata.ino;
    if (catalog.cwd !== binding.cwd || canonicalPath !== binding.canonicalPath || !sameParent || (saved ? !authorized : !sourcePath)
      || requireCatalogRevision && catalog.revision !== binding.catalogRevision) {
      throw new SkillFileError("The native skill file identity changed. Refresh before continuing.", 409, "SKILL_FILE_CHANGED");
    }
    return catalog;
  }

  private async text(binding: Binding): Promise<TextDocument> {
    const document = await binding.workspace.readText(binding.relativePath);
    if (document.kind !== "text") throw new SkillFileError("The native skill file is not editable UTF-8 text.", document.kind === "too-large" ? 413 : 415, "SKILL_FILE_NOT_TEXT");
    return document;
  }

  private async revealInfo(): Promise<NativeSkillFileDocument["reveal"]> {
    if (this.options.reveal) return { label: process.platform === "darwin" ? "Reveal in Finder" : "Reveal in folder", available: true };
    if (process.platform === "darwin") {
      try { await access("/usr/bin/open", constants.X_OK); return { label: "Reveal in Finder", available: true }; }
      catch { return { label: "Reveal in Finder", available: false, reason: "Finder reveal is unavailable on this host." }; }
    }
    if (process.platform === "linux") {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { label: "Reveal in folder", available: false, reason: "This Linux host has no graphical desktop session." };
      try { await access("/usr/bin/xdg-open", constants.X_OK); return { label: "Reveal in folder", available: true }; }
      catch { return { label: "Reveal in folder", available: false, reason: "This Linux host has no supported graphical file manager launcher." }; }
    }
    return { label: "Reveal in folder", available: false, reason: "File reveal is unsupported on this host platform." };
  }

  private async file(binding: Binding, document: TextDocument, catalogRevision: string): Promise<NativeSkillFileDocument> {
    return { protocolVersion: 1, hostId: this.options.hostId, ref: binding.ref, catalogRevision, document, reveal: await this.revealInfo() };
  }

  async read(ref: NativeSkillFileRef): Promise<NativeSkillFileDocument> {
    const binding = await this.bind(ref), document = await this.text(binding);
    const catalog = await this.rebind(binding, true);
    return this.file(binding, document, catalog.revision);
  }

  async write(ref: NativeSkillFileRef, input: { expectedRevision: string; text: string; bom?: boolean }): Promise<NativeSkillFileWriteResult> {
    const binding = await this.bind(ref);
    await this.rebind(binding, true);
    try {
      const result = await binding.workspace.writeText(binding.relativePath, input);
      const catalog = await this.rebind(binding, false), document = await this.text(binding);
      if (result.ok && result.document.revision !== document.revision) throw new Error();
      return { type: "skill.file.write", file: await this.file(binding, document, catalog.revision), conflict: !result.ok };
    } catch {
      throw Object.assign(new Error("The skill file write was dispatched but its final state could not be confirmed. Inspect the current file or retry this exact command receipt."), { code: "OUTCOME_UNKNOWN" });
    }
  }

  async reveal(ref: NativeSkillFileRef): Promise<void> {
    const binding = await this.bind(ref);
    await this.rebind(binding, true);
    if (this.options.reveal) {
      try { return await this.options.reveal(binding.canonicalPath); }
      catch { throw Object.assign(new Error("The file manager launch was dispatched but could not be confirmed. Inspect the host before retrying this exact command receipt."), { code: "OUTCOME_UNKNOWN" }); }
    }
    const info = await this.revealInfo();
    if (!info.available) throw new SkillFileError(info.reason ?? "File reveal is unavailable on this host.", 409, "SKILL_FILE_REVEAL_UNAVAILABLE");
    try {
      if (process.platform === "darwin") await execute("/usr/bin/open", ["-R", binding.canonicalPath], { timeout: 10_000 });
      else if (process.platform === "linux") await execute("/usr/bin/xdg-open", [dirname(binding.canonicalPath)], { timeout: 10_000 });
      else throw new SkillFileError("File reveal is unsupported on this host platform.", 409, "SKILL_FILE_REVEAL_UNAVAILABLE");
    } catch (error) {
      if (error instanceof SkillFileError) throw error;
      throw Object.assign(new Error("The file manager launch was dispatched but could not be confirmed. Inspect the host before retrying this exact command receipt."), { code: "OUTCOME_UNKNOWN" });
    }
  }
}
