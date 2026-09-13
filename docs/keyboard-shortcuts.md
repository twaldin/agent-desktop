# App shortcut ownership

`App.tsx` connects the window-owned keymap controller to 93 installed command IDs from the 148-command catalogue. The remaining 48 IDs are required feature-lane dependencies; seven voice/avatar/account commands are explicit goal exclusions. This is not full keyboard parity. Settings shows installed support independently of current route availability; dispatch still requires an eligible live owner. Configured keys replace defaults once the local cache is resolved. See [stored chat search](session-search.md) for the command menu's backend contract.

| macOS binding | Action | Availability |
| --- | --- | --- |
| Command+N / Command+Shift+O | New chat | App |
| Command+K / Command+Shift+P | Command menu and chat search | App |
| Unassigned; configurable | Switch chat / Keyboard shortcuts settings | App |
| Unassigned; configurable | Copy as Markdown | Current connected, loaded native conversation; unavailable during loading, read failure or another pending clipboard write |
| Command+1–9 or Control+1–9 | Go to numbered chat | Existing logical sidebar slot; the saved Number shortcuts target chooses the primary family |
| Command+O | Open folder | Connected host and available project picker |
| Command+B | Toggle sidebar | App |
| Command+Comma | Open settings | App |
| Command+P | Open file search | Workspace target and owner |
| Option+Command+S | Open side chat | Selected session and OMP btw bridge |
| Command+T | Open browser | Connected selected session and browser bridge |
| Control+Backquote | Open terminal at the configured default dock | Connected workspace and native terminal bridge |
| Control+Shift+G | Open Review | Workspace target and loaded Git status |
| Option+Command+B | Toggle side panel | App |

Outside macOS, the primary Command modifier becomes Control; the two explicit Control panel commands remain Control. Non-Mac matching is source behavior, not desktop acceptance on another platform. Pointer **Files** intentionally opens an Open file tab; Command+P opens the separate file-search dialog. A displayed Files badge does not make those two routes identical.

## Matching and focused input

The bubble-phase dispatcher respects `defaultPrevented`, IME events (including key code 229 and an active composition), repeats, AltGraph and unsupported modifier combinations. It consumes an event only when an eligible callback exists. Option-letter panel commands use physical `KeyboardEvent.code`, because macOS changes the produced character; ordinary primary-modifier commands use `KeyboardEvent.key`. Control+Backquote and Control+Shift+G have their explicit matching branches. Alternate-layout completeness remains unverified.

The composer deliberately retains application commands. Ordinary inputs, selects, rich editors, shadow editors, native terminals and pending-interaction surfaces keep input ownership. `data-app-shortcuts="off"` marks another scoped owner. Only explicitly supplied commands from that focused owner may cross the boundary. Visible dialogs/menus and shortcut recording block application dispatch; the current `blocked()` closure also covers React transient state before its DOM commits. Hidden/closed popups do not block. Unmodified text, Escape and editor Save remain with their controls; configured composer send/steer/queue bindings delegate to the same submission owner as natural send keys.

The Files panel's filter is a narrow exception: its configured `searchFiles` binding opens the existing file-search dialog, as it does from the composer. Other application commands remain excluded from that filter. This does not grant file-search ownership to unrelated inputs, file editors, shortcut-recording controls or blocked surfaces.

Local behavior stays with its existing owner: composer submission follows `general.sendBehavior`; ProseMirror owns composer history; file editors own Save, search, selection and Go to line; terminals own terminal input; dock tabs own navigation and move/close admission. Configurability delegates to these owners rather than duplicating their mutations. Go to line registers after the parent frame ref attaches, so its first mounted editor is immediately eligible without a later active-state change. Browser address focus stays with the current chat/draft and refuses another panel's control.

## General send behavior

General offers Enter, modifier-Enter, and modifier-Enter-if-multiline. The conditional mode sends a single-line draft with Enter and requires modifier-Enter for a multiline draft; Shift+Enter inserts a newline. Modifier+Shift+Enter chooses the opposite queued-follow-up/steer delivery from the saved follow-up mode.

Composition Enter is not a submission. The composer also rejects Chromium's same-timestamp, same-code noncomposing replay after a composing Enter, without a cooldown that would reject a fresh normal Enter. Configured submission bindings use the same owner checks and do not duplicate the control's natural-key dispatch.

## Stable listener lifetime

`App.tsx` installs one listener for its lifetime. A layout effect updates the options ref after each commit so dispatch reads current eligibility and closures:

```tsx
const shortcutOptions = useRef({ options: currentShortcutOptions, withControls: withLocalControlShortcuts });
useLayoutEffect(() => { shortcutOptions.current = { options: currentShortcutOptions, withControls: withLocalControlShortcuts }; });
useEffect(() => installAppShortcuts(window, () => shortcutOptions.current.withControls(shortcutOptions.current.options)), []);
```

Do not add action closures to the install effect dependencies. Reinstalling on a workspace, draft or transcript redraw resets the listener's separate composition flag and can dispatch a shortcut before composition ends. Unavailable callbacks must stay absent; registering guarded no-op callbacks would consume the event prematurely. Keep dock action eligibility and keyboard eligibility aligned, including delayed Git status updates.

## Evidence and remaining work

The private General/Keyboard packet records every catalogue ID as an installed owner, required feature dependency or explicit exclusion. Its actual App reads 90 editable shortcut rows. Conflict detection covers the complete catalogue and fixed editor Find bindings, including defaults for currently uninstalled commands. Reassignment still uses host admission to persist displaced defaults; an incomplete manually authored override is not proof of that operation.

Actual disposable App evidence covers native recording/cancellation, a saved multi-stroke focus command, conflict refusal, offline cached settings with writes disabled, rejected/ambiguous receipt recovery without duplicate command admission, explicit stale rebase, and saved preferences across App and isolated-host restart. Native send-mode and opposite-follow-up cases use provider-free real command admission. A real OS composition sequence exposed and then confirmed the duplicate-Enter correction. Native Command+A and Edit > Select All were exercised separately.

The file-owner smoke covers native file search, numbered task-panel focus, Go to line from both the mounted panel and its shadow editor, exact preview cancellation, and Command+W closing the file tab without closing the window. First-mount registration has its own preserved failure and corrected App receipt. These are exercised paths, not a claim that all 90 command IDs or every focused-owner variant received an individual native run.

Resolved bindings support one-second multi-stroke sequences, recheck eligible owners on every event, and reset progress for composition, blocked surfaces and window blur. Explicit empty bindings do not fall back to defaults. The App caller uses the validated native window slot; unknown saved command IDs remain diagnostics rather than executable actions. The preference observer performs a trailing read after an event during a snapshot and never automatically retries an edit.

Normal window close rejects an edit during cache admission or command dispatch. An ambiguous receipt saved under its window owner is retained without automatic replay. Single-window process restart does not establish full secondary-window recovery. Alternate layouts, physical peer synchronization, complete editor/tool keymaps and the remaining feature-lane consumers retain their own acceptance requirements. Historical source-only receipts below remain qualified to their original scope; they do not override the newer native evidence or establish full parity.

## Numbered chat consumers

The current source maps thread1–thread9 into the existing App dispatcher. On macOS, the saved Number shortcuts target chooses Command or Control for this family; overrides and clears use the same keymap resolver. App builds one sidebar layout model and passes it to OrganizedSidebar and the navigation callbacks. Pinned/custom/host-project/loose ordering comes from the existing app organization. Project collapse and sidebar hiding do not remove logical chat slots; archive/search filters do. Full host/session identity stays attached, including repeated session IDs on different hosts. Only the first nine targets receive callbacks; missing slots remain unhandled. Numbered chats are keyboard-only and do not appear in root command-menu suggestions.

Pure model/listener checks cover ordering, filtering, cross-host dispatch, missing slots and composition across changed targets. They are not an App render, real keyboard event, persistence or native acceptance. The initial project-collapse omission was corrected after tracing the actual pinned provider; its prefinal bytes/test result and failing final-fixture comparison are preserved under `.data/number-shortcuts-2026-09-08/`.

The Number shortcuts preference uses the shared keymap revision, capability-gated durable receipt controller and versioned value. Target edits preserve explicit bindings; reset clears bindings while retaining the selected target. Host admission resolves saved-target defaults. Transport3 exchanges the whole record between updated hosts; older peers remain visibly unsynchronized rather than receiving a lossy rewrite. General/Keyboard native evidence covers the target control and its persistence across App and isolated-host restart, not physical peer synchronization or secondary-window recovery. `focusTab1`–`focusTab9` use the main task strip `[chat, ...content]`, including RTL indexing and panel focus, not an arbitrary right/bottom dock ordinal.


## Numeric main-task selection (source stage)

`focusTab1`–`focusTab9` now consume the pinned numeric list: current chat, then ordered right-content descriptors; bottom tabs are separate. RTL reverses the complete list before the nine-slot cap. Missing slots have no callback, and activation revalidates owner-qualified identity and right membership. Selection opens existing right content without creating another tab/session. Chat selection focuses the current main panel in the existing split layout. App schedules a post-commit, owner-checked panel focus; already-focused descendants retain focus. Numeric task commands remain out of the root palette, as in the pinned registry.

This is required keyboard integration, not the completed unified task strip. The full-width/split layout owner, content-side placement, visible chat pseudo-tab, badges, tab-drag presentation, next/previous semantics and embedded external-focus callback remain open. Current app goal/worktree/skill-file descriptors use the existing right content owner as explicit app/OMP adaptations. There is no separate native grouping or pixel approval from this mapping. Evidence and exact before/after source are private under `.data/main-task-number-2026-09-08/`; source review and real App/OS interaction are pending under the launch hold.

### Right content full-width source integration

The right content controller now supports Fullscreen and Restore split without moving or remounting the chat/dock outlets. Numbered Chat selection from full-width content hides that controller and remembers full width for its next open; ordinary side-panel hide clears the remembered mode. Bottom tabs retain their independent controller and size. Closing the last right tab returns to Chat; moving it to Bottom remembers full width for the next right open. Window-local layout projection accepts older snapshots without a mode and retains layout while omitting transient preview descriptors.

This is source/pure-state coverage under the launch hold, not native layout/focus, process reopen, mounted-editor or pixel acceptance. Unified visible Chat/content strip, content-side placement, next/previous, modifier-click Chat fill, numeric badges, external focus callbacks and native drag behavior remain required.

### Next/previous task navigation

`nextTab` and `previousTab` now resolve through the committed application keymap to current right-content targets. Split mode cycles content only, while closed/full-width mode cycles Chat plus retained right content; Bottom never joins that list. Cross-kind cycles move focus only when the departing panel owns it. Same-kind cycles preserve focus behavior. These native nonnumeric commands allow key repeat for single-stroke bindings and stay out of the command menu (the pinned registry does not enable their command-menu rows). Missing right content leaves the callbacks unavailable. The single installed listener retains popup/input/composition arbitration.

Source and pure-state/listener coverage only under the launch hold: actual DOM/OS focus, external embedded focus, unified visible strip and native key repeat remain unverified. Numeric and full-width prerequisites have independent pending source reviews.

### Configurability versus dispatch eligibility

The keymap page derives configurable support from `APP_COMMAND_BINDING_OWNERS`, the installed dispatcher map, independently of current route, target count or host availability. Connection/pending/stale guards still control writes. Dispatch keeps separate current callback eligibility: Settings/plugins suppress task-tab dispatch and missing slots stay unhandled. Catalogue entries without installed owners are omitted rather than presented as inert controls. The General/Keyboard packet binds the 90-row actual page, native editing and saved-binding delivery to its frozen source.


### Unified visible task strip (source stage)

When retained right content is in full-width mode, or its controller is closed, one shared strip presents the current Chat followed by the existing ordered right tabs. Split mode retains separate conversation and right-content headers; Bottom stays independent. The shared strip moves only the existing DockPanel header into a persistent shell slot. Content outlets and their descriptors keep their existing React placement. The Chat tab is non-closeable and participates in the same roving arrow/Home/End group, including RTL arrows. Selecting it keeps focus on the tab; numbered commands retain their separate panel-focus path. Existing add/close/pin/reorder controls, conversation actions, Environment, status and header context menu remain wired. Closing the last right tab returns focus to Chat, including an asynchronously approved close that changed dock ownership.

Pure state, roving-target and actual DockPanel static-render checks support only those source contracts. No portal mount, DOM event/focus, draft/editor retention, drag, native window or pixel acceptance is claimed under the launch hold. Required follow-ups include modifier-held number hints, Chat context/drag/double-click interactions, content-side placement, full overflow/resize/menu focus behavior and matched native originals. Private freeze: `.data/unified-task-strip-2026-09-08/`.


### Modifier-held task hints (renderer source stage)

The task strip now derives its hint labels from the same effective bindings and ordered targets as numeric dispatch. On macOS, the saved Number shortcuts target chooses Command for primary task numbers or Control when task numbers are secondary. A 500ms hold reveals labels; ordinary key repeats do not restart that delay. RTL reverses the complete Chat/content list before the nine-slot cap. Cleared/unavailable bindings produce no invented labels; custom bindings retain their current display label. Right content can show its slot in split mode; Bottom receives no task-number hints. The unified Chat tab shows its own slot when present.

A window-local renderer observer clears on release, blur, hidden-document or composition and ignores stale queued timers after cleanup. It never consumes or dispatches input. This is not the pinned native macOS modifier-release helper: renderer delivery lost while a native menu or another input surface is active remains a separate required native bridge/acceptance path. No native watcher, OS permission, process, preference or provider change is included here. The badge uses the pinned aria-hidden span plus keycap structure. Pure event-target/timer and static-render checks do not prove actual App hooks, lost-release handling, installed keyboard interaction or appearance. Evidence: `.data/task-shortcut-hints-2026-09-09/`.


### Closed retained-content layout correction

The shared layout action follows pinned Go/Yo: valid retained content in closed or full-width mode offers **Restore split**; open split content offers **Fullscreen**. Restore reopens the still-owned active right tab (or first valid retained tab) beside Chat and clears remembered full width, preserving Bottom and the stored split ratio. With no valid right content there is no layout action. The window header and Dock options use the same label/transition; their presence also drives header space reservation. The old closed-panel Fullscreen callback returned unchanged state and is a preserved rejected snapshot, not accepted wiring.

The generic dock fixture has migrated from onMaximize to the explicit layoutAction. Source/pure-state/static-render checks cover the correction only. Native click/focus, Alt-click fill Chat, empty-new-tab discard, content-side restoration and appearance remain separate required behavior under the launch hold. Evidence: `.data/closed-task-layout-correction-2026-09-09/`.


### Native release lifetime for task hints

The desktop supplements renderer keyup/blur/visibility/composition events with a window-owned release watch after the 500 ms hint delay. Only the authenticated main frame can request/cancel its own UUID. Main serializes replacements until the preceding child closes, fences stale cancellation IDs, and cancels on main-frame navigation, renderer destruction, window closure and approved app quit. Shutdown waits for reaping; a valid `up` response without a clean exit cannot report release. A ten-minute watch deadline escalates termination, and unavailable/error/cancelled outcomes clear the matching hint generation without pretending to observe a physical release.

macOS builds compile `apps/desktop/native/modifier-release.swift` into an app-owned executable. Packaged lookup uses only `Resources/native/modifier-release`; development uses the desktop's `dist/native` output. Missing/nonexecutable/escaping paths return unavailable with no PATH, personal Bun/OMP, host or network fallback. The child receives no inherited provider/auth environment and collects no character events. Parent disappearance also ends its polling lifetime.

The helper samples aggregate Core Graphics modifier flags every 20 ms and uses read-only Input Monitoring preflight. It never requests permission; a denied/revoked preflight reports unavailable. This conservative guard may reject flag polling that could work without listening permission. A release/re-press between samples is unobservable; timing, TCC attribution, signed artifact ownership, native menu/window delivery, sleep/wake and real OS focus remain physical acceptance requirements. Source/compiler/controlled process tests do not establish those behaviors. The launch hold prevents native execution until explicitly coordinated.


### Layout modifier and activating-control focus

The single Fullscreen button accepts Option-click on macOS (Alt-click elsewhere) to fill Chat from split view. This closes retained content without changing its tab order/active identity, Bottom state or split ratio, and without remembering full-content mode for the next open. Ordinary activation fills content. Restore split ignores the modifier and preserves the active Chat/content side: closed content restores beside Chat; full content restores with content active.

Header and Dock options capture modifier and document focus before changing layout or closing the menu. Only an activating control that owned focus requests panel focus after the committed layout; unfocused activation does not steal focus. The existing deferred focus owner revalidates the target/visibility and preserves already-focused descendants. The menu and header use the same state owner, and Settings/plugin routes remain suppressed. This is source and controlled state/event-shape coverage only: real DOM focus, embedded external focus callbacks, native menus/Option-click, content-side placement and empty-new-tab discard remain required under the launch hold.


### Interrupted application quit

Modifier helpers pause admission and drain inside collective window-close preparation, before a quit permit is granted. The gate revalidates renderer generations and the live window set after that await. It retains the reversible pause through the permitted close sequence; a renderer loss/navigation or an unprepared window's veto releases the pause and cancels surviving prepared windows. Only an actual `closed` event for a permitted window is treated as an expected departure. Permanent watch disposal occurs at `will-quit`, with no persistent ready flag bypassing a future collective preparation. This source correction has controlled lifecycle/event-shape tests; native Electron quit ordering, recovery and helper cleanup remain unexercised under the launch hold.

Git blame now has a focused file owner for the command menu and configured keys, with no default binding. The original General packet's 90-row count remains historical; this one-command follow-up does not establish native coverage for the other registered IDs.
