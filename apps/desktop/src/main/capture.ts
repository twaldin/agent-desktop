import { app, type BrowserWindow } from "electron";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

type View = "new-conversation" | "conversation" | "accounts" | "omp" | "appearance" | "files" | "git" | "worktrees" | "terminal";
const views: View[] = ["new-conversation", "conversation", "accounts", "omp", "appearance", "files", "git", "worktrees", "terminal"];
const sizes = [[1200, 820], [1440, 1000], [900, 900]] as const;
const zooms = [0.9, 1, 1.1];
const helpers = `
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const click = (selector, text) => {
    const element = [...document.querySelectorAll(selector)].find(item => visible(item) && (text === undefined || item.textContent.trim() === text));
    if (!element || element.disabled) throw new Error('Rendered control unavailable: ' + selector + (text ? ' / ' + text : ''));
    element.click(); return element;
  };
  const settle = async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
`;
interface Readiness { status: "rendered" | "loading" | "error" | "timeout" | "unavailable"; connected: boolean; errors: string[]; notices: string[]; counts: Record<string, number>; elapsedMs?: number }

/** Opt-in UI navigation/capture of Agent Desktop only. Never submits, signs in, edits settings/files, or creates shells. */
export async function captureDesktop(window: BrowserWindow, destination: string): Promise<void> {
  const selectedViews = process.env.AGENT_DESKTOP_CAPTURE_VIEWS?.split(",") ?? views;
  if (!selectedViews.length || selectedViews.some(view => !views.includes(view as View))) throw new Error("Unknown desktop capture view.");
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  window.webContents.setBackgroundThrottling(false);
  const captures: unknown[] = []; const navigation: unknown[] = [];
  const rendererFiles: Record<string, string> = {};
  const applicationPath = app.getAppPath();
  async function fingerprint(directory: string, relative = "dist/renderer") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), key = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await fingerprint(path, key);
      else if (entry.isFile() && !entry.name.endsWith(".map")) rendererFiles[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  await fingerprint(join(applicationPath, "dist/renderer"));
  for (const file of ["dist/main.cjs", "dist/preload.cjs"]) rendererFiles[file] = createHash("sha256").update(await readFile(join(applicationPath, file))).digest("hex");
  const requestedSession = process.env.AGENT_DESKTOP_CAPTURE_SESSION_ID;
  let context: { hostId?: string; sessionId?: string; projectId?: string; reason?: string } = {};
  const script = <T>(body: string): Promise<T> => window.webContents.executeJavaScript(`(async () => { ${helpers} ${body} })()`);
  const read = (view: View): Promise<Readiness> => script(`
    const view = ${JSON.stringify(view)};
    const connected = document.querySelector('.sidebar-footer .profile-avatar')?.dataset.connection === 'online';
    const scope = view === 'accounts' ? document.querySelector('[aria-label="Accounts settings"]') : view === 'omp' ? document.querySelector('.native-settings') : view === 'appearance' ? document.querySelector('.theme-settings') : ['files','git','worktrees'].includes(view) ? document.querySelector('.workspace-panel') : view === 'terminal' ? document.querySelector('.dock-slot-bottom') : document.querySelector('.main-panel');
    const text = selector => [...(scope?.querySelectorAll(selector) ?? [])].filter(visible).map(item => item.textContent.trim().slice(0, 800)).filter(Boolean);
    const errors = text('[role="alert"], .inline-error');
    const notices = text('[role="status"], .workspace-notice, .terminal-notice, .connection-banner');
    const exists = selector => visible(scope?.querySelector(selector));
    const loading = scope?.matches('[aria-busy="true"]') || !!scope?.querySelector('.spinner, [aria-busy="true"]');
    const loaded = view === 'new-conversation' ? exists('.composer') && connected : view === 'conversation' ? exists('.transcript-scroll') && scope.querySelector('.empty-transcript h2')?.textContent !== 'Loading conversation…' : view === 'accounts' ? exists('.accounts-layout') && !loading : view === 'omp' ? exists('.native-setting') && !loading : view === 'appearance' ? exists('.theme-file-path') && !loading : view === 'files' ? exists('.file-entries') && !loading && !notices.some(item => /Loading directory|Restoring editor/.test(item)) : view === 'git' ? exists('.changes-view') && !loading && !scope.textContent.includes('Git status unavailable') : view === 'worktrees' ? exists('.worktrees-view') && !loading && !notices.some(item => /Loading worktrees/.test(item)) : exists('.terminal-views, .terminal-empty, .native-terminal-view .xterm-screen') && !notices.some(item => /Attaching to the native pane/.test(item)) && !scope.textContent.includes('Loading terminals');
    const missingTerminal = view === 'terminal' && visible(scope) && !scope.querySelector('.dock-native-terminal') && visible(scope.querySelector('.dock-empty-actions'));
    if (missingTerminal) errors.push('No existing terminal tab is open in the bottom dock; the harness does not create shells.');
    return { status: !visible(scope) ? 'loading' : missingTerminal ? 'unavailable' : errors.length ? 'error' : loaded ? 'rendered' : 'loading', connected, errors: [...new Set(errors)], notices, counts: { providers: scope?.querySelectorAll('.provider-row').length ?? 0, accounts: scope?.querySelectorAll('.account-row').length ?? 0, nativeSettings: scope?.querySelectorAll('[data-setting-path]').length ?? 0, visualTokens: scope?.querySelectorAll('.theme-token-control').length ?? 0, files: scope?.querySelectorAll('.file-entry-row').length ?? 0, changedPaths: scope?.querySelectorAll('.git-file-row').length ?? 0, worktrees: scope?.querySelectorAll('.worktree-card').length ?? 0, terminals: scope?.querySelectorAll('.terminal-tab').length ?? 0 } };
  `);
  async function ready(view: View, timeout = 15_000): Promise<Readiness> {
    const start = Date.now(); let state = await read(view);
    while (state.status === "loading" && Date.now() - start < timeout) { await new Promise(resolve => setTimeout(resolve, 120)); state = await read(view); }
    return { ...state, status: state.status === "loading" ? "timeout" : state.status, elapsedMs: Date.now() - start };
  }
  // The footer profile trigger opens the profile menu; its Settings item opens the settings shell with the sidebar navigation.
  async function settings(page: "Accounts" | "OMP" | "Appearance") {
    if (!await script<boolean>(`return visible(document.querySelector('.settings-sidebar'));`)) {
      await script(`click('#active-host'); await settle(); click('.profile-menu [role="menuitem"] > span', 'Settings'); await settle();`);
    }
    await script(`click('.settings-sidebar-item', ${JSON.stringify(page)}); await settle();`);
  }
  // Dock toggles are stable checkboxes; aria-checked reports the open state so closing never toggles a closed dock open.
  const closeDocks = `for (const name of ['Toggle bottom panel', 'Toggle side panel']) { const toggle = document.querySelector('[aria-label="' + name + '"][aria-checked="true"]'); if (visible(toggle)) { toggle.click(); await settle(); } }`;
  async function workspace() {
    if (!context.sessionId) throw new Error(context.reason ?? "No existing local session is available for workspace capture.");
    await script(`
      const close = document.querySelector('button[aria-label="Close settings"], button[aria-label="Close native settings"], button[aria-label="Close appearance settings"]'); if (visible(close)) { close.click(); await settle(); }
      const host = ${JSON.stringify(context.hostId)}, id = ${JSON.stringify(context.sessionId)}, project = ${JSON.stringify(context.projectId)};
      if (project) { const row = [...document.querySelectorAll('[data-project-id]')].find(item => item.dataset.projectId === project && item.dataset.hostId === host); const expand = row?.querySelector('.project-toggle[aria-expanded="false"]'); if (expand) { expand.click(); await settle(); } }
      const session = [...document.querySelectorAll('button[data-session-id]')].find(item => item.dataset.sessionId === id && item.dataset.hostId === host);
      if (!visible(session)) throw new Error('The existing session is not available through the rendered sidebar.');
      if (!session.hasAttribute('aria-current')) { session.click(); await settle(); }
    `);
  }
  const manifest = async () => writeFile(join(directory, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), application: app.getName(), applicationPath, rendererFiles, electron: process.versions.electron, chromium: process.versions.chrome, source: "Agent Desktop hidden Electron renderer; excludes OS decorations. Readiness is recorded independently of screenshot creation; no visual parity score is asserted.", profile: "Dedicated temporary capture profile; live host catalogs, settings, files and terminals", sessionSelection: context, navigation, captures }, null, 2));
  try {
    const initial = await ready("new-conversation", 30_000); navigation.push({ view: "startup", readiness: initial });
    if (initial.connected) context = await script(`
      const state = await window.agentDesktop.getState(); const requested = ${JSON.stringify(requestedSession ?? null)};
      const candidates = state.sessions.filter(item => !item.archived).sort((a,b) => (a.status === 'running' ? 1 : 0) - (b.status === 'running' ? 1 : 0) || a.id.localeCompare(b.id));
      const selected = requested ? candidates.find(item => item.id === requested) : candidates[0];
      return selected ? {hostId:state.host.id, sessionId:selected.id, projectId:selected.projectId ?? undefined} : {hostId:state.host.id, reason:requested ? 'The requested session is not an active local sidebar entry.' : 'This host has no existing session; the harness will not create one.'};
    `);
    else context.reason = "The initial rendered host is disconnected.";
    for (const view of selectedViews as View[]) {
      let readiness: Readiness;
      try {
        if (view === "new-conversation" || view === "conversation") {
          if (view === "new-conversation") await script(`click('.sidebar-actions .nav-action'); await settle();`);
          else await workspace();
          await script(closeDocks);
        }
        if (view === "accounts") { await settings("Accounts"); await ready(view); }
        if (view === "omp") { await settings("OMP"); await script(`click('.native-sidebar nav button', 'All settings'); await settle();`); }
        if (view === "appearance") await settings("Appearance");
        if (["files", "git", "worktrees", "terminal"].includes(view)) {
          await workspace();
          if (view === "terminal") await script(`${closeDocks} click('[aria-label="Toggle bottom panel"][aria-checked="false"]'); await settle();`);
          else await script(`if (!visible(document.querySelector('.workspace-panel'))) { const side = document.querySelector('[aria-label="Toggle side panel"][aria-checked="false"]'); if (side) { side.click(); await settle(); } click('.dock-slot-right .dock-empty-actions button', 'Files'); await settle(); } click('#workspace-tab-${view === "git" ? "changes" : view}'); await settle();`);
        }
        readiness = await ready(view);
      } catch (cause) { readiness = { status: "unavailable", connected: false, errors: [cause instanceof Error ? cause.message : String(cause)], notices: [], counts: {} }; }
      navigation.push({ view, readiness });
      for (const [width, height] of sizes) for (const zoom of zooms) {
        window.setContentSize(width, height); window.webContents.setZoomFactor(zoom);
        const measurement = await script(`
          await settle();
          const selectors = ['.sidebar','.main-header','.composer','.welcome','.sidebar-footer','.transcript-scroll','.transcript','.message-body','.transcript-activity-header','.settings-sidebar','.settings-header','.header-panel-actions','.dock-slot-bottom','.accounts-layout','.provider-sidebar','.provider-detail','.native-scope-bar','.native-sidebar','.native-content','.native-compound','.theme-settings-scroll','.theme-overview','.theme-token-grid','.workspace-panel','.file-browser','.file-editor','.git-files','.diff-view','.worktrees-view','.terminal-panel','.terminal-tabs','.terminal-screen','.native-terminal-scrollport','.native-terminal-grid','.native-terminal-grid .xterm-screen'];
          return { viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}, dark:matchMedia('(prefers-color-scheme: dark)').matches, themeMode:document.documentElement.dataset.theme, material:document.documentElement.dataset.material,
            fontStatus:document.fonts.status, activeSettingsPage:document.querySelector('.settings-sidebar [aria-current]')?.textContent, activeWorkspaceTab:document.querySelector('.workspace-tabs [aria-selected="true"]')?.textContent,
            elements:Object.fromEntries(selectors.map(selector => { const element=document.querySelector(selector); if(!element) return [selector,null]; const box=element.getBoundingClientRect(),style=getComputedStyle(element); return [selector,{visible:visible(element),x:box.x,y:box.y,width:box.width,height:box.height,scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,clientWidth:element.clientWidth,clientHeight:element.clientHeight,background:style.backgroundColor,color:style.color,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,borderRadius:style.borderRadius,padding:style.padding,borders:Object.fromEntries(['Top','Right','Bottom','Left'].map(edge=>[edge.toLowerCase(),{width:style['border'+edge+'Width'],style:style['border'+edge+'Style'],color:style['border'+edge+'Color']}]))}]; })) };
        `);
        const actualReadiness = readiness.status === "unavailable" ? readiness : await read(view);
        const name = `${view}-${width}x${height}-zoom-${zoom}`;
        const raster = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await writeFile(join(directory, `${name}.png`), raster.toPNG());
        captures.push({ name, view, requestedContentSize:[width,height], actualContentSize:window.getContentSize(), zoom:window.webContents.getZoomFactor(), rasterSize:raster.getSize(), readiness:actualReadiness, measurement });
      }
      await manifest();
    }
  } finally { await manifest(); }
}
