import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { parseSessionSearchResult, rankSessionSearchHits, type DesktopBridge, type SessionSearchHit } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { matchingBrowserTabs, nextCommandSearchSection, type CommandBrowserTab } from "./command-browser-tabs";
import "./command-menu.css";

export interface CommandMenuAction {
  id: string;
  title: string;
  description?: string;
  group: string;
  shortcut?: string;
  icon?: ComponentProps<typeof Icon>["name"];
  /** A focus-only action waits until the modal has relinquished focus. */
  deferUntilClose?: boolean;
  onSelect(): void;
}

export interface CommandMenuHost {
  id: string;
  name: string;
  connected: boolean;
  searchAvailable: boolean;
}

export interface CommandMenuRecentChat {
  hostId: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
  hostName?: string;
}

export interface CommandMenuProps {
  actions: readonly CommandMenuAction[];
  hosts: readonly CommandMenuHost[];
  /** Catalog entries for the empty chat drill-in only. Search results always come from the owning hosts. */
  recentChats?: readonly CommandMenuRecentChat[];
  browserTabs?: readonly (CommandBrowserTab & { ownerTitle?: string })[];
  onSelectBrowserTab?(tab: CommandBrowserTab): void;
  bridge: Pick<DesktopBridge, "searchSessions" | "cancelSessionSearch">;
  mode: "commands" | "chats";
  onModeChange(mode: "commands" | "chats"): void;
  onSelectSession(hostId: string, sessionId: string): void;
  onClose(): void;
  /** Restore a captured native owner on cancellation; never fall back if that owner expired. */
  onRestoreFocus?(): void;
}

type ChatEntry = SessionSearchHit & { hostId: string; hostName: string };
type ChatSearch = {
  bridge: CommandMenuProps["bridge"];
  hostSignature: string;
  mode: "commands" | "chats";
  query: string;
  entries: ChatEntry[];
  failedHosts: string[];
  partialHosts: string[];
  moreMatches: boolean;
};

const groupLabels: Record<string, string> = {
  thread: "Chat",
  navigation: "Navigation",
  panels: "Panels",
  workspace: "Project",
  configure: "Configure",
  app: "App",
  skills: "Skills",
};
const groupOrder = ["thread", "navigation", "panels", "workspace", "configure", "app", "skills"];
const quickActionIds = new Set(["newTask", "openFolder"]);

function fuzzy(value: string, query: string): boolean {
  const source = value.toLocaleLowerCase(), wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return true;
  let at = 0;
  for (const character of wanted) {
    at = source.indexOf(character, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

function groupLabel(value: string): string {
  return groupLabels[value] ?? value;
}

export function CommandMenu({ actions, hosts, recentChats = [], browserTabs = [], onSelectBrowserTab, bridge, mode, onModeChange, onSelectSession, onClose, onRestoreFocus }: CommandMenuProps) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false), dispatched = useRef(false);
  const deferredAction = useRef<(() => void) | null>(null);
  const cancelledToOriginalOwner = useRef(false);
  const sectionCycle = useRef(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(""), [retry, setRetry] = useState(0);
  const [search, setSearch] = useState<ChatSearch>(), [searching, setSearching] = useState(false);
  const term = query.trim();
  const matchingBrowsers = mode === "commands" && onSelectBrowserTab ? matchingBrowserTabs(browserTabs, term) : [];
  const hostSignature = JSON.stringify(hosts.map(host => [host.id, host.name, host.connected, host.searchAvailable]));
  const searchableHosts = hosts.filter(host => host.connected && host.searchAvailable);
  const unavailableHosts = hosts.filter(host => !host.connected || !host.searchAvailable)
    .map(host => `${host.name} (${host.connected ? "search unavailable" : "offline"})`);
  const shouldSearch = mode === "chats" ? term.length > 0 : term.length >= 2;

  useEffect(() => {
    let current = true;
    const started: Array<{ hostId: string; requestId: string }> = [];
    setSearch(undefined);
    setSearching(false);
    setSelected("");
    if (!shouldSearch || !bridge.searchSessions || searchableHosts.length === 0) return;
    setSearching(true);
    const timer = window.setTimeout(() => {
      const includeContent = mode === "chats" || term.length >= 3;
      void Promise.allSettled(searchableHosts.map(async host => {
        const request = { query: term, includeContent, limit: 9 } as const;
        const requestId = crypto.randomUUID();
        started.push({ hostId: host.id, requestId });
        const result = await bridge.searchSessions!(request, host.id, requestId);
        return { host, result: parseSessionSearchResult(result, host.id, request) };
      })).then(results => {
        if (!current) return;
        const entries: ChatEntry[] = [], failedHosts: string[] = [], partialHosts: string[] = [];
        let moreMatches = false;
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            failedHosts.push(searchableHosts[index]?.name ?? "A host");
            continue;
          }
          const { host, result: value } = result.value;
          entries.push(...value.hits.map(hit => ({ ...hit, hostId: host.id, hostName: host.name })));
          if (value.coverage === "partial" || value.unreadableSessions > 0 || value.unsearchedSessions > 0) partialHosts.push(host.name);
          moreMatches ||= value.moreMatches;
        }
        setSearch({ bridge, hostSignature, mode, query: term, entries: rankSessionSearchHits(entries).slice(0, 9), failedHosts, partialHosts, moreMatches: moreMatches || entries.length > 9 });
        setSearching(false);
      });
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
      for (const request of started) void bridge.cancelSessionSearch?.(request.requestId, request.hostId).catch(() => {});
    };
  }, [bridge, hostSignature, mode, retry, shouldSearch, term]);

  const visibleSearch = search?.bridge === bridge && search.hostSignature === hostSignature && search.mode === mode && search.query === term ? search : undefined;
  const matchingActions = useMemo(() => {
    const eligible = (term ? actions.filter(action => fuzzy(`${action.title} ${action.description ?? ""} ${action.group} ${action.shortcut ?? ""}`, term)) : actions)
      .filter(action => action.id !== "searchChats");
    return [...eligible].sort((left, right) => {
      const leftGroup = groupOrder.indexOf(left.group), rightGroup = groupOrder.indexOf(right.group);
      const group = (leftGroup < 0 ? groupOrder.length : leftGroup) - (rightGroup < 0 ? groupOrder.length : rightGroup);
      return group || actions.indexOf(left) - actions.indexOf(right);
    });
  }, [actions, term]);
  const quickActions = term ? [] : matchingActions.filter(action => quickActionIds.has(action.id));
  const groupedActions = matchingActions.filter(action => term || !quickActionIds.has(action.id));
  const actionGroups = useMemo(() => {
    const values = new Map<string, CommandMenuAction[]>();
    for (const action of groupedActions) values.set(action.group, [...(values.get(action.group) ?? []), action]);
    return [...values];
  }, [groupedActions]);
  const chatAction = actions.find(action => action.id === "searchChats");
  const canSearchChats = Boolean(chatAction && bridge.searchSessions && searchableHosts.length > 0);
  const showChatSwitcher = mode === "commands" && canSearchChats && (!term || fuzzy(`${chatAction?.title ?? ""} ${chatAction?.description ?? ""} search chats past conversations`, term));
  const hasNavigationGroup = actionGroups.some(([group]) => group === "navigation");

  const cancel = () => {
    if (dispatched.current || cancelledToOriginalOwner.current) return;
    if (!onRestoreFocus) { onClose(); return; }
    // Native input must not fall into the timer gap between modal disposal and
    // Radix's deferred unmount autofocus. Remove the modal/trap, then hand input
    // back to its captured original owner before the next native event.
    cancelledToOriginalOwner.current = true;
    flushSync(onClose);
    onRestoreFocus();
  };
  const closeForAction = (action: () => void, deferUntilClose = false) => {
    if (dispatched.current) return;
    dispatched.current = true;
    if (deferUntilClose) deferredAction.current = action;
    onClose();
    if (!deferUntilClose) action();
  };
  const enterChats = () => { onModeChange("chats"); setQuery(""); setSelected(""); requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); };
  const leaveChats = () => { onModeChange("commands"); setQuery(""); setSelected(""); requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); };

  const chatStatus = (() => {
    if (!bridge.searchSessions) return "Chat search requires a newer desktop app.";
    if (hosts.length === 0) return "No hosts are available for chat search.";
    if (searchableHosts.length === 0) return hosts.some(host => host.connected) ? "Chat search is unavailable on the connected hosts." : "Reconnect a host to search chats.";
    if (!term) return mode === "chats" && recentChats.length === 0 ? "Type to search past chats." : undefined;
    if (mode === "commands" && term.length < 2) return undefined;
    if (searching || !visibleSearch) return "Searching chats…";
    if (visibleSearch.entries.length === 0 && visibleSearch.failedHosts.length === searchableHosts.length) return "Chat search failed on every available host.";
    if (visibleSearch.entries.length === 0) return "No chats found.";
    return undefined;
  })();

  return <Dialog.Root open onOpenChange={open => { if (!open && !composing.current) cancel(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="command-menu-overlay"/>
      <Dialog.Content className="command-menu" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus({ preventScroll: true }); }}
        onEscapeKeyDown={event => { if (composing.current) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const action = deferredAction.current; deferredAction.current = null;
          if (action) action();
          else if (!dispatched.current && !cancelledToOriginalOwner.current) {
            if (onRestoreFocus) onRestoreFocus();
            else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
          }
        }}>
        <Dialog.Title className="sr-only">Command menu</Dialog.Title>
        <Dialog.Description className="sr-only">Search commands and past chats.</Dialog.Description>
        <Command label="Command menu" shouldFilter={false} loop value={selected} onValueChange={setSelected}
          onKeyDownCapture={event => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation(); }}>
          <div className="command-menu-search">
            {mode === "chats" && <button type="button" className="command-menu-back" aria-label="Back to commands" onMouseDown={event => event.preventDefault()} onClick={leaveChats}><Icon name="browserBack"/></button>}
            <Command.Input ref={input} placeholder={mode === "chats" ? "Search chats" : "Search chats or run a command"} value={query} maxLength={256}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              onValueChange={value => { sectionCycle.current = false; setQuery(value); setSelected(""); }}
              onKeyDown={event => {
                if (mode !== "commands" || event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || composing.current || event.nativeEvent.isComposing) return;
                const root = event.currentTarget.closest("[cmdk-root]");
                const first = Array.from(root?.querySelectorAll<HTMLElement>("[data-command-menu-search-section]:not([hidden])") ?? [])
                  .flatMap(section => { const item = section.querySelector<HTMLElement>('[cmdk-item]:not([aria-disabled="true"])'); return item ? [item] : []; });
                const selectedSection = root?.querySelector('[cmdk-item][aria-selected="true"]')?.closest("[data-command-menu-search-section]");
                const value = nextCommandSearchSection(first.map(item => item.dataset.value ?? ""), first.findIndex(item => item.closest("[data-command-menu-search-section]") === selectedSection), sectionCycle.current, event.shiftKey);
                if (value === undefined) return;
                event.preventDefault(); sectionCycle.current = true; setSelected(value);
                first.find(item => item.dataset.value === value)?.scrollIntoView({ block: "nearest" });
              }}/>
          </div>
          <Command.List className="command-menu-results" label="Suggestions" aria-busy={searching}>
            {mode === "commands" && quickActions.length > 0 && <Command.Group heading="Quick actions">{quickActions.map(action => <CommandAction key={action.id} action={action} onSelect={() => closeForAction(action.onSelect, action.deferUntilClose)}/>)}</Command.Group>}
            {shouldSearch && visibleSearch?.entries.length ? <Command.Group heading="Chats" data-command-menu-search-section="chats">{visibleSearch.entries.map(entry => <Command.Item className="command-menu-item command-menu-chat" value={`chat:${entry.hostId}:${entry.sessionId}`} key={`${entry.hostId}:${entry.sessionId}`} onSelect={() => closeForAction(() => onSelectSession(entry.hostId, entry.sessionId))}>
              <Icon name="sideChat"/><span className="command-menu-copy"><strong>{entry.title || "Untitled chat"}</strong>{entry.snippet && <small>{entry.snippet}</small>}</span><span className="command-menu-meta">{entry.match === "history" && <span className="command-menu-history">History</span>}<span className="command-menu-host">{entry.hostName}</span></span>
            </Command.Item>)}</Command.Group> : null}
            {matchingBrowsers.length > 0 && <Command.Group heading="Browser tabs" data-command-menu-search-section="browser-tabs">{matchingBrowsers.map(tab => <Command.Item key={tab.id} value={`browser:${tab.id}`} className="command-menu-item" onSelect={() => closeForAction(() => onSelectBrowserTab?.(tab))}>
              <Icon name="globe"/><span className="command-menu-copy"><strong title={tab.title || tab.url}>{tab.title || tab.url}</strong><small title={tab.url}>{tab.url ? tab.detailsUnavailable ? `Last observed: ${tab.url}` : tab.url : "Page details unavailable"}</small></span><span className="command-menu-host">{browserTabs.find(entry => entry.id === tab.id)?.ownerTitle}</span>
            </Command.Item>)}</Command.Group>}
            {mode === "commands" && actionGroups.map(([group, entries]) => <Command.Group heading={groupLabel(group)} key={group}>{showChatSwitcher && group === "navigation" && chatAction && <ChatModeItem action={chatAction} onSelect={enterChats}/>}{entries.map(action => <CommandAction key={action.id} action={action} onSelect={() => closeForAction(action.onSelect, action.deferUntilClose)}/>)}</Command.Group>)}
            {showChatSwitcher && !hasNavigationGroup && chatAction && <Command.Group heading="Navigation"><ChatModeItem action={chatAction} onSelect={enterChats}/></Command.Group>}
            {mode === "chats" && !term && recentChats.some(chat => chat.pinned) && <Command.Group heading="Pinned chats">{recentChats.filter(chat => chat.pinned).map(chat => <RecentChat key={`${chat.hostId}:${chat.sessionId}`} chat={chat} onSelect={() => closeForAction(() => onSelectSession(chat.hostId, chat.sessionId))}/>)}</Command.Group>}
            {mode === "chats" && !term && recentChats.some(chat => !chat.pinned) && <Command.Group heading="Recent chats">{recentChats.filter(chat => !chat.pinned).map(chat => <RecentChat key={`${chat.hostId}:${chat.sessionId}`} chat={chat} onSelect={() => closeForAction(() => onSelectSession(chat.hostId, chat.sessionId))}/>)}</Command.Group>}
            {chatStatus && (mode === "chats" || shouldSearch) && <p className="command-menu-status" role={visibleSearch?.failedHosts.length === searchableHosts.length ? "alert" : "status"}>{chatStatus}</p>}
            {shouldSearch && (unavailableHosts.length > 0 || Boolean(visibleSearch && (visibleSearch.failedHosts.length > 0 || visibleSearch.partialHosts.length > 0 || visibleSearch.moreMatches))) && <div className="command-menu-notice" role="status">
              <span>{[unavailableHosts.length ? `Not searched: ${unavailableHosts.join(", ")}.` : "", visibleSearch?.failedHosts.length ? `Search failed on ${visibleSearch.failedHosts.join(", ")}.` : "", visibleSearch?.partialHosts.length ? `Some history was unavailable on ${visibleSearch.partialHosts.join(", ")}.` : "", visibleSearch?.moreMatches ? "More matches are available; refine your search." : ""].filter(Boolean).join(" ")}</span>
              {Boolean(visibleSearch?.failedHosts.length) && <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button>}
            </div>}
            {mode === "commands" && term && matchingActions.length === 0 && !canSearchChats && <p className="command-menu-status">No commands found.</p>}
          </Command.List>
        </Command>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function ChatModeItem({ action, onSelect }: { action: CommandMenuAction; onSelect(): void }) {
  return <Command.Item value="command-menu-search-chats" keywords={["search chats", "past conversations"]} className="command-menu-item" onSelect={onSelect}><Icon name={action.icon ?? "search"}/><span className="command-menu-copy"><strong>{action.title}</strong>{action.description && <small>{action.description}</small>}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</Command.Item>;
}

function RecentChat({ chat, onSelect }: { chat: CommandMenuRecentChat; onSelect(): void }) {
  return <Command.Item className="command-menu-item command-menu-chat" value={`recent:${chat.hostId}:${chat.sessionId}`} onSelect={onSelect}>
    <Icon name="sideChat"/><span className="command-menu-copy"><strong>{chat.title || "Untitled chat"}</strong></span>{chat.hostName && <span className="command-menu-host">{chat.hostName}</span>}
  </Command.Item>;
}

function CommandAction({ action, onSelect }: { action: CommandMenuAction; onSelect(): void }) {
  return <Command.Item value={`command:${action.id}`} keywords={[action.title, action.description ?? "", action.group]} className="command-menu-item" onSelect={onSelect}>
    {action.icon && <Icon name={action.icon}/>}<span className="command-menu-copy"><strong>{action.title}</strong>{action.description && <small>{action.description}</small>}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}
  </Command.Item>;
}
