import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DraftBrowserOwnerRecord } from "./browser-draft-owner-records";
import type { HostStore } from "./store";

export interface DraftBrowserAdmissionRequest {
  hostId: string;
  ownerId: string;
  draftId: string;
  draftRevision: number;
}
export interface DraftBrowserAdmission {
  readonly fresh: boolean;
  readonly record: Readonly<DraftBrowserOwnerRecord>;
  /** Sample the original binding immediately before use; failure permanently retires this admission. */
  assertCurrent(): void;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
function directory(path: string) {
  const cwd = realpathSync(path), info = statSync(cwd, { bigint: true });
  if (!info.isDirectory()) throw new Error("The draft browser directory is not a directory");
  return { cwd, device: info.dev, inode: info.ino };
}

/** Host-internal admission, before worker acquisition. HTTP authentication is a separate boundary. */
export class DraftBrowserAdmissions {
  private readonly defaultDirectory: string;
  constructor(private readonly store: HostStore, defaultDirectory: string) {
    if (!isAbsolute(defaultDirectory) || defaultDirectory.includes("\0")) throw new Error("The host default directory must be absolute");
    this.defaultDirectory = resolve(defaultDirectory);
  }

  admit(value: DraftBrowserAdmissionRequest): DraftBrowserAdmission {
    if (!value || !identity(value.hostId) || !identity(value.ownerId) || !identity(value.draftId)
      || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 1) throw new Error("Invalid draft browser admission");
    const request = { hostId: value.hostId, ownerId: value.ownerId, draftId: value.draftId, draftRevision: value.draftRevision };
    if (request.hostId !== this.store.host.id) throw new Error("The draft browser belongs to another host");
    const prior = this.store.draftBrowserOwners.get(request.ownerId);
    if (prior && (prior.draftId !== request.draftId || prior.draftRevision !== request.draftRevision)) throw new Error("The draft browser identity already has different input");
    if (prior?.retiredAt !== undefined) throw new Error("The draft browser owner is retired");
    const draft = prior ? undefined : this.store.getDraft(request.draftId);
    if (!prior && (!draft || draft.revision !== request.draftRevision)) throw new Error("The saved draft changed before browser admission");
    const projectId = prior ? prior.projectId : draft!.projectId;
    const path = this.ownerPath(projectId), original = directory(path);
    // Project paths are already canonical catalog identities; a substituted symlink cannot redirect one.
    if (projectId !== null && original.cwd !== path) throw new Error("The draft browser project directory changed");
    if (prior && prior.cwd !== original.cwd) throw new Error("The draft browser directory no longer matches its original binding");
    const claimed = this.store.draftBrowserOwners.claim({ id: request.ownerId, draftId: request.draftId,
      draftRevision: request.draftRevision, projectId, cwd: original.cwd });
    const record = Object.freeze({ ...claimed.record }), serialized = JSON.stringify(record);
    let invalidated = false;
    const assertCurrent = () => {
      if (invalidated) throw new Error("The draft browser admission is no longer current");
      try {
        const saved = this.store.draftBrowserOwners.get(record.id);
        if (!saved || saved.retiredAt !== undefined || JSON.stringify(saved) !== serialized) throw new Error("The draft browser owner changed or retired");
        const currentPath = this.ownerPath(record.projectId);
        if (currentPath !== path) throw new Error("The draft browser project binding changed");
        const current = directory(currentPath);
        if (current.cwd !== original.cwd || current.device !== original.device || current.inode !== original.inode) throw new Error("The draft browser directory identity changed");
      } catch (error) {
        invalidated = true;
        throw error;
      }
    };
    assertCurrent();
    return Object.freeze({ fresh: claimed.fresh, record, assertCurrent });
  }

  private ownerPath(projectId: string | null): string {
    if (projectId === null) return this.defaultDirectory;
    const project = this.store.getProject(projectId);
    if (!project || project.hostId !== this.store.host.id || !isAbsolute(project.path) || resolve(project.path) !== project.path) throw new Error("The draft browser project is not owned by this host");
    return project.path;
  }
}
