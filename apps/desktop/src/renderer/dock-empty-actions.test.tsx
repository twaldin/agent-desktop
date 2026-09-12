import { expect, test } from "bun:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DockEmptyActions } from "./DockEmptyActions";
import type { DockAddAction } from "./DockPanel";
import type { DockDestination } from "./dock-state";

interface ElementProps { children?: ReactNode; onClick?(): void }

// Run the hook-owning component through React, retaining only its semantic
// button callbacks. Browser activation and focus remain Electron coverage.
function renderActions(props: Parameters<typeof DockEmptyActions>[0]) {
  const activate: Array<() => void> = [];
  const collect = (node: ReactNode): void => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<ElementProps>(child)) continue;
      if (child.type === "button" && child.props.onClick) activate.push(child.props.onClick);
      else collect(child.props.children);
    }
  };
  const Probe = () => {
    const tree = DockEmptyActions(props);
    collect(tree);
    return tree;
  };
  return { markup: renderToStaticMarkup(createElement(Probe)), activate };
}

test("an intercepted action does not also open its default panel", () => {
  let opened: DockDestination | undefined;
  let intercepted: DockDestination | undefined;
  const action: DockAddAction = { id: "browser", label: "Browser", icon: "globe", onSelect: destination => { opened = destination; } };
  const rendered = renderActions({ actions: [action], destination: "bottom", onSelect: (_action, destination) => { intercepted = destination; } });
  rendered.activate[0]!();
  expect(intercepted).toBe("bottom");
  expect(opened).toBeUndefined();
});

test("clearing a shortcut removes its hint without removing the action", () => {
  let opened = false;
  const action: DockAddAction = { id: "files", label: "Files", icon: "folder", shortcut: "⌘⇧F", onSelect: () => { opened = true; } };
  const render = (shortcut: string | undefined) => renderActions({ actions: [{ ...action, shortcut }], destination: "right" });
  // Static markup proves the hint content only, not native key or visual behavior.
  expect(render(action.shortcut).markup).toContain("⌘⇧F");
  for (const shortcut of ["", undefined]) {
    const rendered = render(shortcut);
    expect(rendered.markup).not.toContain("<kbd");
    opened = false;
    rendered.activate[0]!();
    expect(opened).toBe(true);
  }
});
