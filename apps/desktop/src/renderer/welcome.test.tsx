import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "../../../../packages/shared/src/protocol";
import type { GitStatus } from "../../../../packages/shared/src/workspace";
import { Welcome } from "./Welcome";
import type { WorkspaceState } from "./workspace-state";

const project: Project = { id: "project", hostId: "host", name: "Codex UI Reference", path: "/fixture/project", createdAt: 1 };
const status: GitStatus = { revision: "a".repeat(64), branch: "main", head: "b".repeat(40), upstream: null, ahead: 0, behind: 0, entries: [] };
const workspace = (git?: GitStatus) => ({ status: git, subscribe: () => () => {} }) as unknown as WorkspaceState;

describe("new-chat welcome", () => {
  test("uses the native repository prompt and project popup semantics without a generic subtitle", () => {
    const html = renderToStaticMarkup(<Welcome project={project} workspace={workspace(status)} onSelectProject={() => {}}/>);
    expect(html).toContain("What should we build in ");
    expect(html).toContain('aria-label="Codex UI Reference?"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Codex UI Reference?</button>");
    expect(html).toContain('class="welcome-mark"');
    expect(html).toContain('width="716" height="716" viewBox="149 149 418 418"');
    expect(html).toContain('mask="url(#welcome-mark-outline)"');
    expect(html.match(/stroke-width="24"/g)).toHaveLength(2);
    expect(html).not.toContain("Choose a project or start a conversation.");
    expect(html).not.toContain("<p>");
  });

  test("distinguishes a directory project and the projectless new-chat state", () => {
    const directory = renderToStaticMarkup(<Welcome project={project} workspace={workspace()} onSelectProject={() => {}}/>);
    const projectless = renderToStaticMarkup(<Welcome workspace={undefined} onSelectProject={() => {}}/>);
    expect(directory).toContain("What should we work on in ");
    expect(directory).not.toContain("What should we build in ");
    expect(projectless).toContain("What should we build?");
    expect(projectless).not.toContain("aria-haspopup");
  });
});
