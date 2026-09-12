import type { DockDestination } from "./dock-state";

/** The presentation owner supplies instance identity, not just a reusable dock ID.
 * Selection must revalidate these captured destinations before replacing a tab. */
export interface BrowserWorkspaceTab {
  id: string;
  instanceId: string;
  destination: DockDestination;
  title: string;
  label?: boolean;
}
export interface BrowserWorkspaceAction {
  id: string;
  title: string;
  singletonTabId?: string;
}
export type BrowserWorkspaceChoice<Tab extends BrowserWorkspaceTab, Action extends BrowserWorkspaceAction> =
  | { kind: "chat"; id: string; title: string }
  | { kind: "tab"; id: string; title: string; tab: Tab }
  | { kind: "action"; id: string; title: string; action: Action };
export type BrowserWorkspaceMatch<Tab extends BrowserWorkspaceTab, Action extends BrowserWorkspaceAction> =
  BrowserWorkspaceChoice<Tab, Action> & {
    textMatch?: "exact" | "prefix" | "substring";
    isExistingDestination: boolean;
    canBeDefault: boolean;
  };

/** Pinned so: Chat, right/Bottom tabs, then the existing eligible action catalogue.
 * This builds choices only. It neither creates native resources nor selects tabs. */
export function browserWorkspaceChoices<Tab extends BrowserWorkspaceTab, Action extends BrowserWorkspaceAction>(
  chatTitle: string,
  tabs: readonly Tab[],
  actions: readonly Action[],
  source: Pick<BrowserWorkspaceTab, "id" | "destination">,
): BrowserWorkspaceChoice<Tab, Action>[] {
  const choices: BrowserWorkspaceChoice<Tab, Action>[] = [{ kind: "chat", id: "chat", title: chatTitle }];
  for (const destination of ["right", "bottom"] as const) {
    for (const tab of tabs) {
      if (tab.destination !== destination || tab.label || tab.id === source.id && tab.destination === source.destination) continue;
      choices.push({ kind: "tab", id: JSON.stringify(["tab", destination, tab.instanceId, tab.id]), title: tab.title, tab });
    }
  }
  for (const action of actions) {
    if (action.singletonTabId !== undefined && tabs.some(tab => tab.id === action.singletonTabId)) continue;
    choices.push({ kind: "action", id: JSON.stringify(["action", action.id]), title: action.title, action });
  }
  return choices;
}

/** Pinned io + popup ordering. URL eligibility belongs to the existing address
 * parser and is supplied by its caller; a title match alone must not steal Enter. */
export function matchBrowserWorkspaceChoices<Tab extends BrowserWorkspaceTab, Action extends BrowserWorkspaceAction>(
  choices: readonly BrowserWorkspaceChoice<Tab, Action>[],
  query: string,
  locale: string,
  canBeDefault: boolean,
): BrowserWorkspaceMatch<Tab, Action>[] {
  if (query.length === 0) return choices.filter(choice => choice.kind === "action")
    .map(choice => ({ ...choice, isExistingDestination: false, canBeDefault: false }));
  const normalized = query.trim().toLocaleLowerCase(locale);
  if (!normalized || /^[a-z][a-z\d+.-]*:/i.test(normalized) || normalized.startsWith("www.")) return [];
  const rank = { exact: 0, prefix: 1, substring: 2 };
  return choices.flatMap(choice => {
    const title = choice.title.toLocaleLowerCase(locale);
    if (!title.includes(normalized)) return [];
    const textMatch: "exact" | "prefix" | "substring" = title === normalized ? "exact" : title.startsWith(normalized) ? "prefix" : "substring";
    return [{ ...choice, textMatch, isExistingDestination: choice.kind !== "action", canBeDefault }];
  }).sort((left, right) => rank[left.textMatch] - rank[right.textMatch]
    || Number(right.isExistingDestination) - Number(left.isExistingDestination));
}
