import { createRoot } from "react-dom/client";
import { LocalEnvironmentSettings } from "../../apps/desktop/src/renderer/LocalEnvironmentSettings";
import { SettingsSidebar } from "../../apps/desktop/src/renderer/SettingsSidebar";
import type { DesktopBridge, Project, WorkspaceQueryResult, CommandResult } from "../../packages/shared/src/protocol";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";
import { applyTheme } from "../../apps/desktop/src/renderer/theme-application";
import { DEFAULT_THEME } from "../../packages/shared/src/theme";
applyTheme({ ...DEFAULT_THEME, mode: "dark" });
const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!, project = JSON.parse(params.get("project")!) as Project;
const projects = params.has("projects") ? JSON.parse(params.get("projects")!) as Project[] : [project];
const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
  return response.json();
};
const bridge: Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe"> = {
  workspaceQuery: (target, query) => post<WorkspaceQueryResult>("/v1/workspace/query", { target, query }),
  command: envelope => post<CommandResult>("/v1/commands", envelope), subscribe: () => () => {},
};
createRoot(document.getElementById("root")!).render(<div className="app-shell settings-open">
  <SettingsSidebar page="environments" environmentAvailable onSelect={() => {}} onBack={() => {}} />
  <main className="main-panel"><LocalEnvironmentSettings bridge={bridge as DesktopBridge} hostId={project.hostId} hostName="Fixture host" connected projects={projects} initialProjectId={project.id} onClose={() => {}} /></main>
</div>);
Object.assign(window, {
  async acceptanceTarget(selector: string) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing input target ${selector}`);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(requestAnimationFrame);
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom > innerHeight || rect.top < 0) throw new Error(`Input target is not visible: ${selector}`);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },
  acceptanceState() {
    const box = (selector: string) => {
      const element = document.querySelector(selector); if (!element) return null;
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
      font: getComputedStyle(document.body).fontFamily, background: getComputedStyle(document.documentElement).backgroundColor,
      sidebar: box(".settings-sidebar"), form: box(".local-environment-form"), name: box(".local-environment-field input"),
      overview: box(".local-environment-overview"), projectCards: [...document.querySelectorAll('.environment-project-card')].map(element => ({ label: element.getAttribute('aria-label'), expanded: element.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') })),
      summary: box(".environment-summary"), summaryText: document.querySelector(".environment-summary")?.textContent,
      repair: Boolean(document.querySelector(".local-environment-repair textarea")),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
    };
  },
});
