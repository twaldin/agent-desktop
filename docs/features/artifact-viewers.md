# Retained tool results and declared file viewers

Completed native MCP tool results can open their declared UI with the original saved result. A connected selected session can also open a declared file viewer from its workspace file list or a relative transcript file link. These panels reuse the MCP Apps dock, sandbox, permission pipeline, original connection/channel ownership and close drain.

## Original tool results

The OMP tool bridge retains the original MCP structured result, response metadata, declaration metadata captured before invocation, and effective protocol arguments. Transcript projection uses the exact saved native entry, never formatted tool text or a reused tool-call ID. Result metadata takes precedence over declaration metadata when choosing the UI resource. Historical records without this metadata are not upgraded by rerunning tools.

Opening captures the original host/session/native entry/server/tool/resource. The worker revalidates that exact saved result and captures the original connected MCP server. It reads only the UI resource and returns the saved initial arguments/result; it never calls the historical tool. Missing old-host support fails explicitly. New interactions initiated inside that app still pass the existing native tool approval and extension hooks.

The saved window descriptor contains the original native entry reference rather than a duplicate result payload. Reload and reconnect require deliberate reopening; source loss, session retirement, or connection replacement rejects old operations. Renderer title changes do not supply a new source.

## Declared file viewers

Pinned Codex 7982 `app-initial-86767c3d23e5.js` uses `jzi` to read file entrypoints, `lzi` for longest normalized suffix matching, and `dzi`/`fzi`/`pzi` for original host resources. A tool must advertise `_meta["openai/ui"].entrypoints` with `type: "file"`, extensions, and a `ui://` resource. Matching ignores case and leading extension dots; declaration order breaks equal-length ties. Generic MCP resources are not invented as viewers.

A file panel owns one session directory, relative path and fresh `codex-resource://` URI. That URI and its descendants map only to that same original file. Host resources never reach the external MCP server. The entrypoint receives `{file:{name,resourceUri}}`; the native initial tool call receives original absolute-path metadata. It uses the same native approval/extension pipeline as other app tool calls. Repeated opening selects the retained file panel, and a retired panel receives a fresh presentation. Files-origin callbacks capture their original dock presentation and revalidate it inside the queued insertion; closing and reopening that source cannot authorize a stale file selection.

Resource reads return exact text or base64 bytes and `_meta["openai/resource"]` containing the content revision and writability. Writes use the pinned `openai/resources/write` method with text or blob and an exact `ifMatch` revision. The existing workspace authority handles bounds, path confinement, original-directory checks, serialized updates, tempfile flush, rename and directory flush. Text and binary writes share this implementation. A conflict preserves external bytes and returns the current revision; the viewer must deliberately refresh before saving again. Missing revisions, malformed binary data, foreign URIs and missing files never become an unconditional overwrite or create.

Viewer reads and writes are limited to 1 MiB, within the 2 MiB JSON envelope. Oversized writes return `too-large`; invalid or oversized reads fail visibly. Original channel cancellation is checked immediately before the file mutation. Once mutation starts, its flush/result verification drains even if the document retires; publication still requires the original channel. These are sampled application ownership checks and existing filesystem primitives, not a claim of atomic exclusion against every external OS writer.

## Acceptance scope

The controlled tests exercise retained-result projection and no-replay opening, stale entry/connection guards, descriptor matching, resource URI isolation, text/binary revision conflicts and final save admission. The real worker fixture uses the actual OMP tool registry, deterministic local model transport, stdio MCP provider, persisted native session, reconnect/open path and filesystem. The `--artifacts` Open panel fixture mounts the actual App in Electron and drives the production transcript button, declared viewer, save/conflict/refresh, binary representation, foreign-resource rejection, offline recovery and document reload with an isolated authenticated host.

Run results and failures belong to the exact frozen review packet; this document does not assert that an unrun fixture passed. Runtime inputs never use personal credentials, a remote model or a historical tool replay.

This batch supports standard MCP Apps resources and an already loaded selected session's catalogue. Projectless/global MCP owners, retained unselected-session catalogue discovery, legacy Skybridge applications, complete resource-change subscriptions, arbitrary viewer formats and full physical/native parity remain separate requirements. Files tree/path operations keep their separate owner and review scope.
