import { createRoot } from "react-dom/client";
import { EnvironmentCard } from "../../apps/desktop/src/renderer/EnvironmentCard";
import type { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import type { SessionActivitySnapshot } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";

const calls: string[] = [];
const activity = { agents: { availability: "available", value: [] }, jobs: { availability: "available", value: { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } } } as unknown as SessionActivitySnapshot;
const entry = (indexStatus: string, worktreeStatus = ".", kind = "tracked") => ({ path: "a", indexStatus, worktreeStatus, kind });
const workspace = (entries: unknown[], busy = false) => ({ status: { branch: "main", entries, revision: "r", ahead: 0, behind: 0 }, busy, loading: new Set(), subscribe: () => () => {} }) as unknown as WorkspaceState;
const sourceList = [1, 2, 3, 4].map(n => ({ id: String(n), label: `source ${n}`, kind: "file" as const, onOpen: () => calls.push(`source${n}`) }));
const handlers = { onReview: () => calls.push("review"), onCommit: () => calls.push("commit"), onFiles: () => calls.push("files"), onTerminal: () => calls.push("terminal"), onHost: () => calls.push("host"), onClose: () => calls.push("close") };
function Card({ workspace: state, connected = true, className = "" }: { workspace: WorkspaceState; connected?: boolean; className?: string }) { return <div className={className}><EnvironmentCard hostName="Local" cwd="/fixture" local connected={connected} workspace={state} activity={activity} sources={sourceList} {...handlers}/></div>; }
createRoot(document.getElementById("root")!).render(<><Card className="environment-fixture-primary" workspace={workspace([entry("M"), { ...entry("."), path: "b", worktreeStatus: "M" }])}/><div hidden><Card className="environment-fixture-offline" connected={false} workspace={workspace([entry("M")])}/><Card className="environment-fixture-empty" workspace={workspace([entry(".")])}/><Card className="environment-fixture-conflict" workspace={workspace([{ ...entry("U", "U", "conflict"), path: "conflict" }])}/></div></>);

const wait = async (read: () => unknown) => { for (let n = 0; n < 200; n++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("timeout"); };
function requireElement<T extends Element>(value: T | null, description: string): T { if (!value) throw new Error(`Missing ${description}`); return value; }
function click(value: Element | null, description: string) { requireElement(value, description).dispatchEvent(new MouseEvent("click", { bubbles: true })); }
function commitButton(scope: string) { return requireElement(document.querySelector<HTMLButtonElement>(`${scope} .environment-overview > .environment-row:last-child`), `${scope} commit button`); }

Object.assign(window, {
  runEnvironmentAcceptance: async () => {
    await wait(() => document.querySelector(".environment-fixture-primary .environment-card"));
    const primary = ".environment-fixture-primary";
    const rows = document.querySelectorAll<HTMLButtonElement>(`${primary} .environment-overview > .environment-row`);
    if (rows.length !== 4) throw new Error(`Expected four compact overview rows, got ${rows.length}`);
    if (document.querySelectorAll(`${primary} .environment-sources li`).length !== 3) throw new Error("Expected first three sources before expansion");
    click(rows[0]!, "Changes row");
    click(rows[3]!, "Commit row");
    click(document.querySelector(`${primary} .environment-host > button:first-child`), "Host row");
    click(document.querySelector(`${primary} .environment-row-action`), "Terminal action");
    click(document.querySelector(`${primary} .environment-sources li button`), "first source");
    click(document.querySelector(`${primary} .environment-link`), "View all sources");
    await wait(() => document.querySelectorAll(`${primary} .environment-sources li`).length === 4);
    click(document.querySelector(`${primary} button[aria-label="Close environment summary"]`), "Close action");
    click([...document.querySelectorAll<HTMLButtonElement>(`${primary} .environment-link`)].find(item => item.textContent?.trim() === "Browse files") ?? null, "Browse files");
    const disabled = [".environment-fixture-offline", ".environment-fixture-empty", ".environment-fixture-conflict"].map(scope => commitButton(scope).disabled);
    if (!disabled.every(Boolean)) throw new Error("Commit must be disabled offline, with no index changes, and with conflicts");
    const required = ["review", "commit", "host", "terminal", "source1", "close", "files"];
    if (!required.every(call => calls.includes(call))) throw new Error(`Missing callback: ${required.filter(call => !calls.includes(call)).join(", ")}`);
    return { passed: true, checks: ["initial three sources and View all expansion", "review, commit, host, terminal, file, source, and close callbacks", "offline, empty-index, and conflict commits disabled"], calls, disabled, sourceCount: document.querySelectorAll(`${primary} .environment-sources li`).length };
  },
  environmentGeometry: () => {
    const card = requireElement(document.querySelector<HTMLElement>(".environment-fixture-primary .environment-card"), "environment card").getBoundingClientRect();
    const computed = getComputedStyle(requireElement(document.querySelector<HTMLElement>(".environment-fixture-primary .environment-card"), "environment card"));
    return { width: card.width, height: card.height, background: computed.backgroundColor, color: computed.color, fitting: card.width > 0 && card.width <= Math.min(300, innerWidth - 20) };
  },
});
