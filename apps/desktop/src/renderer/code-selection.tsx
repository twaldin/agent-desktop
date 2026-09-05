import { Component, createRef, type ReactNode } from "react";

interface CodeProps { text: string; children: ReactNode }
interface SelectionSnapshot { anchor: number; focus: number; active: Element | null }
function offset(root: HTMLElement, node: Node, position: number): number {
  const range = root.ownerDocument.createRange(); range.selectNodeContents(root); range.setEnd(node, position); return range.toString().length;
}
function point(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset), last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length; last = node;
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: root, offset: 0 };
}
/** React's snapshot lifecycle runs before token spans change in the commit.
 * Preserve a selection wholly inside this code block without moving user focus.
 * Selections spanning multiple transcript blocks remain a later reading contract.
 */
export class SelectableCode extends Component<CodeProps, object, SelectionSnapshot | null> {
  private element = createRef<HTMLElement>();
  getSnapshotBeforeUpdate(previous: CodeProps): SelectionSnapshot | null {
    const code = this.element.current;
    if (!code || previous.text === this.props.text) return null;
    const selection = code.ownerDocument.getSelection();
    if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed || !code.contains(selection.anchorNode) || !code.contains(selection.focusNode)) return null;
    return { anchor: offset(code, selection.anchorNode, selection.anchorOffset), focus: offset(code, selection.focusNode, selection.focusOffset), active: code.ownerDocument.activeElement };
  }
  componentDidUpdate(_previous: CodeProps, _state: object, snapshot: SelectionSnapshot | null) {
    const code = this.element.current;
    if (!code || !snapshot || code.ownerDocument.activeElement !== snapshot.active) return;
    const anchor = point(code, snapshot.anchor), focus = point(code, snapshot.focus);
    code.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }
  render() { return <code ref={this.element}>{this.props.children}</code>; }
}
