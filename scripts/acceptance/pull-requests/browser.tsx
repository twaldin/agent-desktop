import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PullRequestsPage } from "../../../apps/desktop/src/renderer/PullRequestsPage";
import { PullRequestCache } from "../../../apps/desktop/src/renderer/pull-request-cache";
import { createPullRequestsBridge } from "../../../apps/desktop/src/main/pull-requests-preload";
import {
  defaultPullRequestFilters,
  type PullRequestWindowView,
} from "../../../apps/desktop/src/pull-request-window-state";
import type { DesktopBridge } from "../../../packages/shared/src/protocol";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";
const api = (window as any).pullRequestFixture;
const cache = new PullRequestCache();
let control: (value: { connected?: boolean; open?: boolean }) => void;
let saved: PullRequestWindowView | undefined;
const bridge = {
  pullRequests: createPullRequestsBridge((channel, host, input) =>
    api.call(channel, host, input),
  ),
  openExternal: (url: string) => api.call("external", url),
} as DesktopBridge;
function Fixture() {
  const [state, setState] = useState({ connected: true, open: true });
  control = (value) => setState((old) => ({ ...old, ...value }));
  return state.open ? (
    <PullRequestsPage
      bridge={bridge}
      hostId="host-a"
      hostName="Work"
      hosts={[{ id: "host-a", name: "Work" }]}
      connected={state.connected}
      supported
      initial={
        saved ?? {
          hostId: "host-a",
          accountId: null,
          selected: null,
          filters: defaultPullRequestFilters(),
        }
      }
      cache={cache}
      onChanged={(view) => {
        saved = view;
      }}
      onSelectHost={() => {
        throw new Error("Unexpected host switch");
      }}
      onClose={() => control({ open: false })}
    />
  ) : (
    <button onClick={() => control({ open: true })}>
      Reopen pull requests
    </button>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
(window as any).pullRequestsControl = (value: {
  connected?: boolean;
  open?: boolean;
}) => control(value);
(window as any).pullRequestsState = () => ({
  saved,
  body: document.body.innerText,
  alerts: [...document.querySelectorAll('[role="alert"]')].map(
    (node) => node.textContent,
  ),
});
(window as any).pullRequestsTarget = (selector: string, text?: string) => {
  const node = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.width &&
        rect.height &&
        (text === undefined ||
          node.innerText?.trim() === text ||
          node.getAttribute("aria-label") === text)
      );
    },
  );
  if (!node)
    throw new Error(`Missing rendered target ${selector} ${text ?? ""}`);
  node.scrollIntoView({ block: "nearest" });
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};
