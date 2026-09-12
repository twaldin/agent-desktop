import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerContext } from "./ComposerContext";
import { EnvironmentCard } from "./EnvironmentCard";
import type { WorkspaceState } from "./workspace-state";

const workspace = {
  gitAvailability: "not-repository", status: undefined, branches: [], worktrees: [], loading: new Set(), errors: {},
  restored: true, busy: false, connected: true, pending: undefined, subscribe: () => () => {},
} as unknown as WorkspaceState;

test("non-repository workspaces do not render branch controls in composer or environment summaries", () => {
  const composer = renderToStaticMarkup(<ComposerContext hostId="home" hostName="Home" hosts={[]} projects={[{ id: "plain", path: "/tmp/plain", name: "Plain" } as any]}
    projectId="plain" connected addingProject={false} workspace={workspace} execution={{ type: "local" } as any} worktreesAvailable onProject={() => {}} onHost={() => {}} onAddProject={() => {}}
    onExecution={() => {}} onOpenGitSettings={() => {}}/>);
  const environment = renderToStaticMarkup(<EnvironmentCard hostName="Home" cwd="/tmp/plain" local connected workspace={workspace} sources={[]}
    onReview={() => {}} onCommit={() => {}} onFiles={() => {}} onTerminal={() => {}} onHost={() => {}} branchPrefix="codex/" onOpenGitSettings={() => {}}
    collapsedSections={[]} onToggleSection={() => {}}/>);
  expect(composer).not.toContain("Switch branch"); expect(composer).not.toContain("What branch should this chat start from?");
  expect(environment).not.toContain("Switch branch");
});
