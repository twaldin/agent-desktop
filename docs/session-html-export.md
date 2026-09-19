# Native conversation HTML export

Conversation actions → Export conversation creates native OMP HTML on the session's owning host. Choose OMP web themes or the native user themes configured on that host. Save as downloads the exact recorded bytes through authenticated transport and the existing native file-copy transaction. Save and open uses the same native save dialog and opens the chosen local HTML copy. Remote host paths are never treated as client-local files.

`/export` and `/export --themes` use the same host service. The native extension/custom command ordering is checked before admission and again in the captured worker. `/export --copy`, `copy`, and `clipboard` retain the native text: “Use /dump to copy the session to clipboard.” Client-selected `/export` paths are refused with Save as guidance; the host always reserves its own destination. No provider response is needed.

The renderer records the request before sending. The existing host command ledger joins concurrent duplicates and returns completed receipts after restart. An interrupted pending command or lost worker acknowledgement remains unknown; neither inspection nor retry starts another export. An explicit retry of a request absent from the host uses its original ID and theme. Completed exports can be exported again only through a new explicit action.

## Ownership and files

`SessionExportService` captures catalog identity, native session file identity, and the original worker. It requires an idle saved session and rechecks ownership after asynchronous boundaries. Private metadata records the generated artifact ID, directory identities, original session and result metadata. Receipts contain only host/session/command IDs, an opaque artifact ID, SHA-256, byte count, and theme. No schema migration or separate command ledger is introduced.

The native adapter calls pinned `AgentSession.exportToHtml`; it does not render its own transcript. It exclusively creates a mode-0600 file in the host's mode-0700 export directory using `O_EXCL | O_NOFOLLOW`, keeps its `node:fs` FileHandle open across the awaited native export, and passes `/dev/fd/<fd>` as the output path. In pinned 18.1.10 the native implementation generates the standalone HTML then calls `Bun.write(outputPath, html)`; it does not rename or replace the destination. File-descriptor access therefore keeps the original reserved inode even if the pathname changes after reservation. The adapter syncs and closes the file in `finally`.

This requires the scoped macOS/Linux host descriptor interface and Bun runtime. Actual macOS arm64 Bun 1.3.14 worker tests verify the file-descriptor write and both themes. Linux descriptor behavior and packaged installed artifacts require their separate runtime acceptance. An unavailable descriptor path or native write error produces an unknown result after dispatch, retains private diagnostics, and never silently falls back to a path write or repeated export.

Private-directory inode checks and `O_NOFOLLOW` reads reject symlinks, directory/file replacement, hardlinked output, and changed source ownership. These checks are not an atomic cross-process directory compare-and-swap: the private owning-user directory is the filesystem authority boundary. No other-user access is granted. A hostile process with the same user's filesystem authority can still race pathname resolution before exclusive file reservation; detection prevents a completed receipt but is not an OS sandbox against that process.

Export reads are limited to 32 MiB per file and four concurrent host reads. Generation uses the native exporter, so its intermediate memory/disk usage is not streaming-limited; oversized results are retained as unconfirmed and cannot be downloaded. Completed downloads verify the original SHA-256 and size before a user-selected destination is replaced. Old/private exports are retained for recovery; no automatic deletion or quota eviction is added.

## Controlled validation

The focused suites are `session-export.test.ts`, `session-export-native-http.test.ts`, `omp/session-export.test.ts`, `omp-workers/session-export-native.test.ts`, and the desktop `session-export` transport/state tests. They cover native export/themes and hostile/tool content, authenticated host-to-client saving, journal replay/restart, command precedence and guidance, absent-request retry, unknown outcomes, replacement and write errors, size limits, and preservation of a destination on tampered downloads.

These tests use isolated data, saved native sessions, and workers with outbound fetch disabled. Native dialog selection is controlled in tests; no provider, installed/retained GUI, physical cross-device, or reference appearance acceptance is implied. Save and open's operating-system browser launch and dialog keyboard/layout checks remain GUI acceptance work.
