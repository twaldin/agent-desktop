import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { observeDialogHeight } from "./dialog-height";

/** Mount inside the portal so both DOM refs exist for the measurement effect.
 * The natural-height child owns body padding; the measured surface owns height. */
export function BranchSwitchContent({ children, ...props }: ComponentPropsWithoutRef<typeof Dialog.Content>) {
  const content = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current && body.current) return observeDialogHeight(content.current, body.current);
  }, []);
  return <Dialog.Content {...props} ref={content}><div ref={body}>{children}</div></Dialog.Content>;
}
