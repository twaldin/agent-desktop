# Owning-host files and Git

`WorkspaceService` in `apps/host/src/workspace/` operates on one existing canonical directory. Shared data types live in `packages/shared/src/workspace.ts`; HTTP request/result types live in `packages/shared/src/workspace-protocol.ts`.

The desktop supplies a `WorkspaceTarget` containing exactly one catalog `projectId` or `sessionId`. The host resolves its directory, including a session's worktree or projectless directory. A renderer-supplied absolute directory is not workspace authority. Construct the service with that resolved directory and a host-controlled `worktreeRoot`, normally `<host data>/worktrees/<project or session id>`.

## File API

| Operation | Result and behavior |
| --- | --- |
| `list(relativePath = ".")` | Entries include type, size, modification time and POSIX permission bits. Directories sort first. Symlinks disclose their link target and whether it resolves inside, outside or is missing. Listing does not open outside targets. |
| `stat(relativePath)` | Metadata for the entry itself, including a symlink rather than its contents. |
| `readText(relativePath)` | A tagged `FileContent`: UTF-8 text with SHA-256 revision, binary, unsupported UTF-16/32 BOM encoding, or oversized. The default editor limit is 2 MiB. Oversized files have no fabricated content hash. |
| `writeText(relativePath, { text, expectedRevision, bom? })` | The exact raw-byte SHA-256 revision is required. `null` means create only. A conflict returns `{ok:false,code:"REVISION_CONFLICT",current}` and leaves the file unchanged by this operation. Success returns the saved text document. |

Paths must be relative, without traversal. Canonical symlinks inside the directory can be read and edited; saves preserve the symlink and replace its target. Outside and broken symlink writes fail. Returned file paths are canonical relative paths. Missing parent directories are reported rather than created implicitly. Special files, including FIFOs, are rejected before reading; invalid UTF-8 and NUL-containing files are not silently converted into editable text.

Text saves preserve UTF-8 BOM by default, caller-provided line endings, existing owner/group and POSIX read/write/execute bits. They check write permission, write and sync an exclusive temporary file, recheck the content revision, replace the destination atomically and sync its directory. A new file uses atomic create-only linking. Files are read again after saving; an immediate external content change is reported. Native filesystem errors remain visible. ACLs, extended attributes and hard-link identity are not preserved by atomic replacement; this is not an all-metadata file editor.

Writes through two `WorkspaceService` instances in the same host process serialize by canonical file path. The caller must retain attempted unsaved text while showing a conflict; a conflict result contains the latest disk state and does not persist a separate editor draft.

## Git API

Git operations require the owning directory itself to be the repository or linked-worktree root. They do not silently act on a parent repository. Commands use the system `git` executable with argument arrays and literal pathspecs, without a shell. Native Git identity, configuration, hooks and signing behavior remain active. The backend never pushes, contacts remotes, resets working files or inserts author trailers.

| Operation | Result and behavior |
| --- | --- |
| `gitStatus()` | Branch, HEAD, upstream, ahead/behind, exact tracked/untracked/conflict paths and an index/HEAD `revision`. Porcelain v2 with NUL-separated records preserves whitespace and newlines in filenames. |
| `branches()` | Local branches and locally known remote refs; this does not fetch. |
| `diff({path?,staged?,context?})` | Actual Git patch and binary indication. Staged and unstaged views are separate. An individually selected untracked file uses Git's no-index diff. External diff/text conversion programs are disabled for inspection. |
| `stage(paths)` | Stages current on-disk contents of the selected literal paths and returns fresh status. Deleted files and deleted parent directories work. |
| `unstage(paths, expectedRevision?)` | Restores index entries from the inspected HEAD without replacing working files. On a validated unborn branch it removes only cached entries. |
| `commit(message, expectedRevision?)` | Commits the current index through native Git, returning the actual commit id and Git summary. Native conflicts, hooks, identity, signing and other failures are surfaced. |

`GitStatus.revision` hashes HEAD and staged index entries, including content ids, modes and merge stages. It deliberately does not change for an unstaged working-file edit. Send the reviewed revision with commit and unstage; a changed HEAD or index raises `GIT_REVISION_CONFLICT` before the operation. The optional argument supports programmatic callers that intentionally operate on current state. App Git operations and status reads serialize by canonical owning directory. Status reads retry when the index or HEAD changes during inspection.

Git output is bounded to 8 MiB and requires UTF-8 metadata/filenames. A narrower diff is required when output is too large. The default process timeout is 30 seconds. A timeout during a mutation is an uncertain outcome: inspect the repository before retrying, and do not automatically replay the side effect.

## Managed worktrees

`worktrees()` lists all registered worktrees, including read-only metadata for trees outside the configured managed root. `createWorktree({path,branch?,newBranch?,startPoint?})` accepts a path relative to the managed root. It can use an existing branch, create an explicitly named new branch, or create a detached tree from the chosen commit (default HEAD). Git validates refs and commit resolution. The managed root is created when needed; the requested path's parent must exist and its final destination must not exist.

`removeWorktree(relativePath)` removes only a registered linked worktree inside the managed root. It refuses the current workspace, locked trees, any tracked/untracked/ignored content, and detached commits unreachable from a surviving branch or tag. Removal invokes ordinary `git worktree remove`, with no force flag and no branch deletion. The host adapter must additionally reject removal while a catalog session is running in that tree; the filesystem backend has no session catalog.

## Concurrency boundary and evidence

These checks prevent accidental traversal, ordinary stale saves and conflicting app review actions. They are not an OS sandbox against a malicious process continuously replacing parent directories or Git metadata. Another editor or CLI can modify a file/index in the narrow interval after the final revision check. File replacement itself is atomic; arbitrary external writers do not participate in the host's revision protocol. Native Git retains its own index/ref locking, but this backend does not claim a cross-process conditional Git transaction.

`bun run test apps/host/src/workspace/service.test.ts` uses temporary actual files and Git repositories, including native commits and worktrees. It covers competing saves, external changes, create-only writes, symlink boundaries, UTF-8 BOM/CRLF/mode preservation, binary/encoding/size/special-file outcomes, permission denial, literal and newline paths, rename/deletion/conflict status, independent staged/unstaged diff, unborn unstage, two-client stale review rejection, preservation of later working edits, clean/dirty/ignored/locked/unowned worktrees and detached commit preservation. Fixtures configure their own test Git identity and empty hooks directory; they do not modify user repositories or claim live host/UI acceptance.


## New-chat starting-state gap

The release23 context strip selects the owning host/project and checks out an actual local branch. It does not yet select a new managed worktree for session creation. `Draft`/`DraftInput` has no starting-state descriptor; the durable `SubmissionController` create envelope carries a project but no worktree mode. Host `session.create` selects its working directory without creating a worktree. The existing worktree mutation is a separate durable command, so invoking it from the UI before submission would leave a gap between two receipts.

The integration must capture starting-state intent with the draft/submission and let the owning host recover worktree plus session creation under the original create command identity. Acceptance needs one managed worktree across retries, correct native session directory, host reservation conflicts, and preservation of later draft edits. The reference's branch choice and treatment of uncommitted source changes still need to be traced before selecting the final behavior; current backend limitations are not permission to remove those app features.
