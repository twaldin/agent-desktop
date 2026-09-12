import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DockEmptyActions } from "./DockEmptyActions";
import type { DockAddAction } from "./DockPanel";
import type { DockDestination } from "./dock-state";

interface ElementProps { children?: ReactNode; onClick?(): void }

// Inspect the pure element tree only to exercise dispatch precedence. Browser
// activation, focus order and presentation are covered by Electron verification.
function buttons(node: ReactNode): ReactElement<ElementProps>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<ElementProps>(child)) return [];
    return child.type === "button" ? [child] : buttons(child.props.children);
  });
}

test("an intercepted action does not also open its default panel", () => {
  let opened: DockDestination | undefined;
  let intercepted: DockDestination | undefined;
  const action: DockAddAction = { id: "browser", label: "Browser", icon: "globe", onSelect: destination => { opened = destination; } };
  const tree = DockEmptyActions({ actions: [action], destination: "bottom", onSelect: (_action, destination) => { intercepted = destination; } });
  buttons(tree)[0]!.props.onClick!();
  expect(intercepted).toBe("bottom");
  expect(opened).toBeUndefined();
});

test("clearing a shortcut removes its hint without removing the action", () => {
  let opened = false;
  const action: DockAddAction = { id: "files", label: "Files", icon: "folder", shortcut: "⌘⇧F", onSelect: () => { opened = true; } };
  const render = (shortcut: string | undefined) => DockEmptyActions({ actions: [{ ...action, shortcut }], destination: "right" });
  // Static markup proves the hint content only, not native key or visual behavior.
  expect(renderToStaticMarkup(render(action.shortcut))).toContain("⌘⇧F");
  for (const shortcut of ["", undefined]) {
    const tree = render(shortcut);
    expect(renderToStaticMarkup(tree)).not.toContain("<kbd");
    opened = false;
    buttons(tree)[0]!.props.onClick!();
    expect(opened).toBe(true);
  }
});
