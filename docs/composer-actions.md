# Native composer actions

The desktop composer reads commands, skills, file references, native references, and command argument completions from the owning OMP host. Catalogs and completion callbacks stay on that host; the renderer receives bounded labels, descriptions, insertion text, availability, and diagnostics.

## Catalogs

`POST /v1/composer/actions` accepts an optional catalogued project or session target and a refresh flag. A project or new-conversation query uses read-only OMP 18.1.10 discovery. It scans native command, template, extension, and skill locations without importing extension factories, starting MCP servers, creating a session, or creating history. Since registration code has not run, discovered extension modules are visible as pending entries rather than guessed commands.

A session query reads the actual loaded native registries. It includes extension callbacks, custom and MCP prompt commands, builtins, file commands, prompt templates, and skills. Collisions remain visible; availability follows the dispatcher order. Builtin aliases are returned with their canonical row. `referenceSchemes` comes from the active OMP internal URL router's completion handlers, without a renderer-owned scheme list. Each response has a content-derived revision used to reject stale completion callbacks.

Builtin commands which depend on the terminal UI, coordinated lifecycle changes, provider login, or configuration reload stay visible with `pending`, `partial`, or `disabled` availability and a reason. The current dispatcher enables reviewed text handlers. `/session` is partial: info is executable, while deletion and account pin operations remain in their owning desktop controls.

## Completions and insertion

`POST /v1/composer/completions` accepts one of:

- `file`: native `@` filesystem completion, including OMP quoting for paths with spaces.
- `reference`: loaded-session internal resource completion.
- `command-argument`: extension callback results or builtin subcommands.

Queries are limited to 2,048 characters, 100 returned entries, a 16 KiB request, and a 2 MiB response. Native callback failures become diagnostics and do not fabricate choices. Argument `insertText` replaces the entire current argument prefix; text after the caret remains the renderer's responsibility. Skill selection inserts `/skill:<name> ` because that is the pinned native parser syntax. It is rejected inside a leading non-skill slash command, `!` or `$` local execution, or after an earlier skill invocation.

## Dispatch and receipts

Slash commands must begin at the start of the submitted draft. An unknown slash command is rejected instead of being sent to a model. Loaded extension handlers take precedence, followed by custom commands, reviewed builtins, file commands, and prompt templates. Native skill tokens use OMP's skill parser and builder; successful admission is certified by the exact persisted `skill-prompt` custom-message entry and a completed flush.

Native handler exceptions after dispatch have unknown outcome because their side effects may already have happened. The worker reports `OUTCOME_UNKNOWN`, and callers retain the original command identity rather than retrying with a new identity.

Bounded output from a reviewed builtin handler is appended as native app metadata:

```text
type: custom
customType: agent-desktop.command-output
data: { command, output }
```

The session manager is flushed before the `native-command` admission receipt is returned. That receipt contains the stable metadata `entryId`. Transcript projection exposes the same entry as role `commandOutput` with a single `commandOutput: { entryId, command, output }` field. It is not a user or assistant message and does not enter model context. Reopening the native session preserves the entry. Retrying the same host command ID returns the immutable stored receipt without invoking the handler or appending output again, including after a host restart.

## Ownership and compatibility

Requests carry `X-Agent-Host-Id`; both request and successful response must match the selected endpoint. A missing or changed project/session is `STALE_TARGET`, a changed catalog is `COMPOSER_CATALOG_CHANGED`, and an owner mismatch is `OWNER_MISMATCH`. The desktop treats only a plain, uncoded route-level 404 as an older host without this API. Authentication failures and coded 404 responses remain errors.

This integration is pinned to OMP 18.1.10. It does not claim that pending TUI handlers, lifecycle-changing commands, interactive login flows, or unloaded MCP registration callbacks are executable.

## Renderer checks

The production App combines `/` app actions with native commands, inserts skills through `$`, and asks the owner for `@` file paths, native URI schemes and command arguments. The popup follows the composer bounds, supports arrows/Enter/Tab/Escape, and defers to IME composition. Scope changes discard late responses; failed app actions retain the authored draft. Pending native capabilities remain visible with their reason.

Eight focused renderer tests cover literal-token boundaries, selection/caret replacement, native quoting, command arguments, host/workspace identity, collisions and skill nesting. Six workflow groups passed in isolated hidden Electron with the actual App and a controlled host bridge. The captured popup fits at 1780×1111, 1200×1000, 760×1000 and 150% zoom. The fixture explicitly dispatches focus events because its window is hidden. It does not prove installed keyboard behavior or provider execution. Evidence: `.data/composer-ui-acceptance/run5/result.json`. Native backend tests separately exercise OMP execution and persistence.

Command-output metadata appears as its own expandable operator output, preserving literal text rather than interpreting it as assistant Markdown. The floating Environment card, dock layout parity, and still-pending native commands remain separate work; this selector is not full feature parity.
