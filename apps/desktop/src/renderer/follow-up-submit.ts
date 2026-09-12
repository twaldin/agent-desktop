import type { FollowUpDelivery, PreferenceValues } from "@agent-desktop/shared";

export interface ComposerEnterKey {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  keyCode: number;
  isComposing: boolean;
}

export interface EffectiveSendMode {
  readonly normal: "enter" | "mod-enter";
  readonly opposite: "mod-enter" | "mod-shift-enter";
}

const enterMode: EffectiveSendMode = { normal: "enter", opposite: "mod-enter" };
const conditionalSingleLineMode: EffectiveSendMode = { normal: "enter", opposite: "mod-shift-enter" };
const modifiedMode: EffectiveSendMode = { normal: "mod-enter", opposite: "mod-shift-enter" };

/** Authored newlines represent logical lines in our single-paragraph, hard-break editor.
 * Unlike normal send, the pinned opposite shortcut follows the saved preference, not line count.
 */
export function effectiveSendMode(sendBehavior: PreferenceValues["general.sendBehavior"], authoredText: string): EffectiveSendMode {
  if (sendBehavior === "enter") return enterMode;
  if (sendBehavior === "mod-enter") return modifiedMode;
  return authoredText.includes("\n") ? modifiedMode : conditionalSingleLineMode;
}

/** Call after autocomplete. A null selected delivery means idle; null output leaves the key to the editor. */
export function submissionForEnter(event: ComposerEnterKey, mode: EffectiveSendMode,
  selected: FollowUpDelivery | null): "send" | FollowUpDelivery | null {
  if (event.key !== "Enter" || event.altKey || event.isComposing || event.keyCode === 229) return null;
  const modified = event.metaKey || event.ctrlKey;
  const inverse = modified && (mode.opposite === "mod-enter" ? !event.shiftKey : event.shiftKey);
  if (selected !== null && inverse) return selected === "follow-up" ? "steer" : "follow-up";
  if (event.shiftKey || (!modified && mode.normal === "mod-enter")) return null;
  return selected ?? "send";
}
