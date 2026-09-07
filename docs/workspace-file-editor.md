# Workspace file editor

The Files panel uses the pinned Pierre editor over the existing host-owned workspace service. `WorkspaceState` remains the authority for file content, revisions, dirty buffers, recoverable conflicts and mutation receipts. The renderer does not write through a second editor-specific backend.

## Editing and navigation

Each open text file has a stable editor instance while the Files panel remains mounted. Switching files or temporarily viewing Changes preserves its undo history and selection. Hiding a dock keeps the editor mounted but inactive. A line request waits for the owning file read and visible editor, then selects the requested one-based line or places the caret at its one-based UTF-16 column. Invalid locations show an error against the current buffer, including unsaved edits. LF, CRLF and CR line boundaries are supported.

Keyboard editing and find come from Pierre. Command/Control-S uses the existing manual Save path. The editor remains writable offline and during an in-flight save; the save callback respects connection, restoration and pending-command gates. Editor controls own their keyboard events before app shortcuts.

Syntax highlighting uses the existing pinned review theme data. Editor background, code font family, size, weight and line height use the app's theme tokens. No additional dependency or runtime version was introduced.

## File preservation

- A save persists its original command ID before dispatch and includes the baseline revision. A lost receipt retains that ID for explicit recovery.
- Edits made after submission remain dirty when the saved revision is acknowledged.
- Each file has an in-memory generation. A read response from before a later edit, resolution or save receipt cannot replace that newer state or introduce a stale conflict.
- Offline text is cached under the host and workspace identity. Reconnection reads the host file before an explicit save; divergent local and host revisions remain separate.
- Choosing the host version retains the previous local text for recovery. Keeping local edits adopts the inspected host revision for the next explicit save.
- Binary, oversized and unsupported-encoding files retain their existing non-editable states. UTF-8 BOM preservation belongs to the host write contract.

## Evidence and remaining parity

The frozen reference shows a Pierre-family source editor, highlighted source, find and undo. The pinned7982 source trace supports that library choice; its original exact dependency version is not recoverable. App Pierre1.3.5 remains an explicit tested pin.

The implementation is a partial Files checkpoint. General Markdown rich mode, native autosave, breadcrumb/file-tree layout, file menus, go-to-line controls, selection-to-chat, per-file dock tabs and durable undo/scroll restoration still need their respective integration and acceptance. The current directory list, nested file tabs, explicit Save and conflict controls remain visual/interaction differences, not claimed parity. Hidden Electron checks exercise production renderer code against a real isolated authenticated host; they do not certify installed main/preload routing, native-window pixels or cross-machine behavior.

The focused regression passes43 tests/240 assertions, including real filesystem/Git saves and delayed-read cases. The shared skill source/rich regression passes13 checks/10 captures. General Files originals and receipts are under `.data/ui-acceptance/workspace-source-final-2026-09-07/`; source traces, scope, review notes and test/build logs are under `.data/workspace-source-editor-2026-09-07/`. Failed harness selectors from earlier attempts remain in their original private directories.
