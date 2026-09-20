import type { ComposerActionsCatalog } from "@agent-desktop/shared";
import type { SessionUsage } from "../../../../packages/shared/src/session-usage";

/** Match the pinned builtin parser without changing the raw token used for
 * extension/custom precedence. Leading whitespace is rejected by native send. */
export function usageResetArgument(text: string): string | undefined {
  const command = /^\/usage(?:[\s:]([\s\S]*))?$/.exec(text);
  if (!command) return;
  const args = (command[1] ?? "").trim();
  const firstSpace = args.search(/\s/);
  const verb = (firstSpace < 0 ? args : args.slice(0, firstSpace)).toLowerCase();
  if (verb !== "reset") return;
  return firstSpace < 0 ? "" : args.slice(firstSpace + 1).trim();
}

export function nativeUsageResetWinner(catalog: ComposerActionsCatalog, text: string): boolean {
  if (usageResetArgument(text) === undefined) return false;
  const space = text.indexOf(" ");
  const token = space < 0 ? text.slice(1) : text.slice(1, space);
  const literal = catalog.commands.find(row => row.name === token && row.availability !== "shadowed");
  if (literal && ["extension", "custom", "mcp-prompt"].includes(literal.source.kind)) return false;
  const builtin = catalog.commands.find(row => row.id === "builtin:usage" && row.name === "usage" && row.source.kind === "builtin");
  // A plain /usage extension does not own /usage:reset: native dispatch looks
  // up the whole literal token before it splits builtin argument separators.
  if (builtin?.desktopAction !== "usage-reset") throw new Error("Update the owning host to use /usage reset with explicit confirmation. The draft was retained.");
  return true;
}

/** Native semantic outcomes consume the command without dispatching a reset. */
export class UsageResetSelectionNotice extends Error {}

/** Rows come from the native helper in its original order, with exact matching
 * strings. Display projections must never be used as account selectors. */
export function usageResetAccount(snapshot: SessionUsage, argument: string): string | undefined {
  const accounts = snapshot.resetCommandAccounts;
  if (!accounts) throw new Error("Update the owning host before using /usage reset. The draft was retained.");
  if (!accounts.length) throw new UsageResetSelectionNotice("No Codex accounts found. Use /login to add one.");
  const target = argument.trim();
  if (!target) return;
  const wanted = target.toLowerCase();
  const account = wanted === "active" ? accounts.find(row => row.active)
    : accounts.find(row => row.label.toLowerCase() === wanted || row.email?.toLowerCase() === wanted || row.accountId?.toLowerCase() === wanted);
  if (!account) throw new UsageResetSelectionNotice(`No Codex account matches "${target}".`);
  if (account.availableCount <= 0) throw new UsageResetSelectionNotice(`${account.label}: no saved resets to spend.`);
  if (account.unavailable || !snapshot.credits.some(row => row.accountRef === account.accountRef && row.canPrepare))
    throw new Error(`${account.label}: saved resets could not be prepared. Refresh the original account before retrying.`);
  return account.accountRef;
}
