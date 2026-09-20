// Single driver for the native Jobs production-App acceptance. It requires the
// already-built production desktop main (window, preload, bridge, App) and only
// observes transport, sends real Electron input to the actual SessionJobsPanel
// controls, asks the fixture host bridge to create/hold/release REAL detached
// task children in the original native session, and records captures with the
// exact final window/content bounds, minimum size, renderer viewport/DPR/zoom,
// Electron zoom factor/level and PNG dimensions. No DOM mock, fabricated IPC,
// replaced bridge or synthetic job exists here.
const { app, BrowserWindow } = require("electron");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const positional = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
const switches = process.argv.slice(2).filter(argument => argument.startsWith("--"));
const [output, fixture, repository] = positional;
const pauseForBrowser = switches.includes("--pause-for-browser");
const debugPort = switches.find(value => value.startsWith("--remote-debugging-port="))?.split("=")[1];
if (pauseForBrowser) {
  if (!debugPort) throw new Error("--pause-for-browser requires --remote-debugging-port=<port> after the fixture arguments.");
  app.commandLine.appendSwitch("remote-debugging-port", debugPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, "profile")) throw new Error("Private native Jobs profile required.");
const { connection, context } = JSON.parse(readFileSync(join(fixture, "ready.json"), "utf8"));
const primary = context.sessions.primary.id, other = context.sessions.other.id;
const originalFetch = globalThis.fetch, calls = [], inputs = [], captures = [], errors = [], checks = [], controls = [];
let mainWindow, passed = false, failure, pausedMs = 0;
const safeURL = input => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Non-loopback fetch forbidden in native Jobs App acceptance.");
  return url;
};
// Observe production transport only. Bodies of the App's own /jobs requests are recorded; nothing is answered here.
globalThis.fetch = async (input, init) => {
  const url = safeURL(input);
  const jobs = /\/v1\/sessions\/[^/]+\/jobs$/.test(url.pathname);
  const call = jobs ? { seq: calls.length + 1, path: url.pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, owner: new Headers(init?.headers ?? {}).get("X-Agent-Host-Id"), time: Date.now() } : undefined;
  if (call) calls.push(call);
  try {
    const response = await originalFetch(input, { ...init, redirect: "error" });
    if (call) { call.status = response.status; call.result = await response.clone().json().catch(() => undefined); call.done = Date.now(); }
    return response;
  } catch (cause) { if (call) { call.error = String(cause); call.done = Date.now(); } throw cause; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const bounded = async (operation, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
};
const control = async command => {
  const started = Date.now();
  const response = await originalFetch(`${context.control.origin}/control`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${context.control.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const reply = await response.json();
  controls.push({ command, ok: reply.ok, ms: Date.now() - started, ...(reply.ok ? {} : { error: reply.error }) });
  if (!reply.ok) throw new Error(`Fixture control ${command.op} failed: ${reply.error}`);
  return reply.value;
};
const jobsCalls = () => calls.filter(call => call.body?.action);
app.on("browser-window-created", (_event, window) => {
  if (mainWindow) return; mainWindow = window;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    try { const url = new URL(details.url); callback({ cancel: url.hostname !== "127.0.0.1" }); } catch { callback({ cancel: true }); }
  });
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once("did-finish-load", () => void exercise(window));
});

async function exercise(window) {
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const stateExpression = `(() => {
    const section = document.querySelector('section[data-section="jobs"]'), toggle = section?.querySelector('button.environment-section-toggle'), panel = section?.querySelector('div.session-jobs');
    const button = (root, prefix) => { const b = [...(root?.querySelectorAll('button') ?? [])].find(b => (b.getAttribute('aria-label') ?? '').startsWith(prefix)); return b ? { label: b.getAttribute('aria-label'), disabled: b.disabled, title: b.title, pressed: b.getAttribute('aria-pressed') } : null; };
    const rows = [...(panel?.querySelectorAll('li.session-jobs-row') ?? [])].map(li => ({ id: li.dataset.jobId, status: li.dataset.jobStatus, type: li.dataset.jobType, queued: li.dataset.jobQueued === 'true', stale: li.dataset.jobStale === 'true', start: Number(li.dataset.jobStart), group: li.closest('ul.session-jobs-list')?.dataset.group, label: li.querySelector('.session-jobs-label')?.textContent, statusText: li.querySelector('.session-jobs-status')?.textContent, queuedBadge: li.querySelector('.session-jobs-queued')?.textContent ?? null, started: li.querySelector('time.session-jobs-started')?.getAttribute('datetime') ?? null, qualifier: li.querySelector('p.session-jobs-qualifier')?.textContent ?? null, cancel: button(li, 'Cancel '), inspect: button(li, 'Inspect output of ') }));
    const details = [...(panel?.querySelectorAll('div.session-jobs-detail') ?? [])].map(d => ({ id: d.dataset.jobId, consumed: d.dataset.consumed, truncated: d.dataset.truncated, kind: d.querySelector('pre.session-jobs-output')?.dataset.kind, text: d.querySelector('pre.session-jobs-output')?.textContent }));
    const notes = [...(panel?.querySelectorAll('.session-jobs-note') ?? [])].map(n => ({ kind: n.dataset.kind, role: n.getAttribute('role') ?? n.querySelector('[role]')?.getAttribute('role') ?? null, text: n.textContent, cancelState: n.dataset.cancelState ?? null, jobId: n.dataset.jobId ?? null }));
    const delivery = panel?.querySelector('div.session-jobs-delivery');
    return { sessionId: document.querySelector('.session-row[aria-current="page"]')?.dataset.sessionId ?? null, prompt: !!document.querySelector('#prompt'), environment: document.querySelector('button[aria-label="Environment"]')?.getAttribute('aria-checked') ?? null,
      hasSection: !!section, expanded: toggle?.getAttribute('aria-expanded') ?? null, toggleText: toggle?.textContent ?? null, panel: panel ? { stale: panel.dataset.stale, supported: panel.dataset.supported, connected: panel.dataset.connected, busy: panel.getAttribute('aria-busy') } : null,
      summary: panel?.querySelector('span.session-jobs-summary')?.textContent ?? null, rows, details, notes, delivery: delivery ? { queued: delivery.dataset.queued, delivering: delivery.dataset.delivering, text: delivery.textContent } : null, refresh: button(panel, 'Refresh background jobs'), reload: button(panel, 'Reload from native session') };
  })()`;
  const state = () => evaluate(stateExpression);
  const wait = (predicate, label, timeout) => bounded(async () => { const value = await state(); return predicate(value) ? value : null; }, label, timeout);
  const clickTarget = async (expression, label, receiptEvent = "click") => {
    const position = await evaluate(`(() => {const n=${expression};if(!n)throw Error('Missing actual App target: '+${JSON.stringify(label)});if(n.disabled)throw Error('Disabled actual App target: '+${JSON.stringify(label)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Pointer target is obscured: '+${JSON.stringify(label)});window.__jobsAcceptanceClick=undefined;n.addEventListener(${JSON.stringify(receiptEvent)},event=>{window.__jobsAcceptanceClick={trusted:event.isTrusted,target:event.composedPath().includes(n),eventType:event.type};},{once:true});return{x,y};})()`);
    const operation = { method: "Electron sendInputEvent", type: "pointer", label, position, receiptEvent, time: Date.now() }; inputs.push(operation);
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, ...position, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) });
    await delay(100);
    operation.receipt = await evaluate("(() => {const v=window.__jobsAcceptanceClick;delete window.__jobsAcceptanceClick;return v;})()");
    assert(operation.receipt?.trusted && operation.receipt.target && operation.receipt.eventType === receiptEvent, `Pointer did not reach the intended actual App target: ${label}`);
  };
  const clickButton = (ariaLabel, scope = "section[data-section=\"jobs\"]") => clickTarget(`[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b => b.getClientRects().length && b.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)})`, ariaLabel);
  // A refresh is complete only when the App's own /jobs read finished AND the panel reports not busy.
  const refresh = async label => {
    const before = jobsCalls().length;
    await clickButton("Refresh background jobs");
    await bounded(async () => jobsCalls().slice(before).some(call => call.body.action === "read" && call.done), `actual jobs read after refresh: ${label}`);
    return wait(value => value.panel && value.panel.busy === "false", `panel settled after refresh: ${label}`);
  };
  const settled = async () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ innerWidth, innerHeight, devicePixelRatio, visualViewport: { scale: visualViewport.scale, width: visualViewport.width, height: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop }, cssZoom: getComputedStyle(document.documentElement).zoom, documentReady: document.readyState }))))");
  const capture = async label => {
    const jobs = await wait(value => !value.panel || value.panel.busy === "false", `renderer completion before capture ${label}`);
    if (label === "04-inspected" || label === "05-failed") await evaluate("document.querySelector('.session-jobs-detail')?.scrollIntoView({block:'nearest'})");
    const renderer = await settled();
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    writeFileSync(join(output, `${label}.png`), png);
    const contentBounds = window.getContentBounds(), nativeImageSize = image.getSize();
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Capture is not PNG");
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const record = { label, time: Date.now(), window: { bounds: window.getBounds(), contentBounds, minimumSize: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused() },
      zoom: { factor: window.webContents.getZoomFactor(), level: window.webContents.getZoomLevel() }, renderer, nativeImageSize, png: { width: size.width, height: size.height, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"),
        scaleX: size.width / contentBounds.width, scaleY: size.height / contentBounds.height }, jobs };
    captures.push(record); writeFileSync(join(output, `${label}.json`), JSON.stringify(record, null, 2));
    return record;
  };
  const pause = async label => {
    if (!pauseForBrowser) return;
    const shown = !window.isVisible(); if (shown) window.show();
    const marker = join(output, "resume");
    const locator = { label, devtools: { json: `http://127.0.0.1:${debugPort}/json`, list: `http://127.0.0.1:${debugPort}/json/list`, version: `http://127.0.0.1:${debugPort}/json/version` }, resumeMarker: marker,
      how: `Inspect the App in a browser through the DevTools locator (chrome://inspect or the devtoolsFrontendUrl from /json). Continue the SAME automatic run with: touch ${JSON.stringify(marker)}`,
      windowShownForPause: shown, bounds: window.getBounds(), contentBounds: window.getContentBounds(), pid: process.pid, time: Date.now() };
    writeFileSync(join(output, "pause-ready.json"), JSON.stringify(locator, null, 2));
    const started = Date.now();
    while (!existsSync(marker)) { if (Date.now() - started > 55 * 60_000) throw new Error("No resume marker appeared within 55 minutes of the browser pause."); await delay(250); }
    pausedMs = Date.now() - started;
    checks.push(`Paused ${pausedMs}ms for browser inspection at ${label}; resumed by marker on the same automatic run`);
  };
  const rowOf = (value, id) => value.rows.find(row => row.id === id);
  try {
    await wait(value => value.sessionId === primary && value.prompt, "selected primary conversation");
    await clickTarget(`document.querySelector('button[aria-label="Environment"]')`, "Environment");
    await wait(value => value.hasSection, "Environment Jobs section from the production EnvironmentCard");
    if ((await state()).expanded !== "true") { await clickTarget(`document.querySelector('section[data-section="jobs"] button.environment-section-toggle')`, "Jobs toggle"); }
    const empty = await wait(value => value.expanded === "true" && value.panel && value.panel.busy === "false" && value.panel.stale === "false" && value.notes.some(note => note.kind === "empty"), "supported empty Jobs state");
    assert(empty.rows.length === 0 && jobsCalls().some(call => call.body.action === "read" && call.status === 200 && call.result?.result?.snapshot?.availability === "available" && call.result.hostId === connection.hostId && call.result.sessionId === primary), "First actual jobs read did not reach the owning host/session.");
    checks.push("Production EnvironmentCard Jobs section shows the supported-empty native state through preload/main/HTTP/worker RPC");
    await capture("01-empty");

    const spawnA = await control({ op: "spawnTask", sessionId: primary, name: "app-a" });
    assert(spawnA.jobId === "app-a" && spawnA.agentId === "app-a" && spawnA.ownerId, "Original task tool did not register the detached child as an owned job.");
    const reachedA = await control({ op: "awaitReached", name: "app-a" });
    assert(reachedA.kind === "child", "The real child turn did not reach the loopback provider.");
    const runningA = await refresh("app-a running");
    assert(rowOf(runningA, "app-a")?.status === "running" && rowOf(runningA, "app-a").queued === false && rowOf(runningA, "app-a").group === "running" && rowOf(runningA, "app-a").type === "task" && rowOf(runningA, "app-a").cancel && !rowOf(runningA, "app-a").cancel.disabled, `Running real child row missing: ${JSON.stringify(runningA.rows)}`);
    const spawnB = await control({ op: "spawnTask", sessionId: primary, name: "app-b" });
    await control({ op: "waitJob", sessionId: primary, jobId: "app-b", queued: true });
    const queued = await refresh("app-b queued");
    assert(rowOf(queued, "app-b")?.status === "running" && rowOf(queued, "app-b").queued === true && rowOf(queued, "app-b").queuedBadge && rowOf(queued, "app-a").queued === false, `Queued real child row missing: ${JSON.stringify(queued.rows)}`);
    assert(queued.delivery && queued.delivery.queued === "0", `Delivery line absent or wrong: ${JSON.stringify(queued.delivery)}`);
    checks.push(`Two real detached children (${spawnA.jobId}, ${spawnB.jobId}) registered by the original task tool: first running, second queued behind task.maxConcurrency=1`);
    await capture("02-running-queued");
    await pause("02-running-queued");

    const beforeCancel = jobsCalls().length;
    await clickButton("Cancel app-b");
    const requested = await wait(value => value.notes.some(note => note.kind === "cancel" && note.jobId === "app-b" && note.cancelState === "requested"), "cancel requested note for app-b");
    const cancelCall = jobsCalls().slice(beforeCancel).find(call => call.body.action === "cancel" && call.body.job?.id === "app-b");
    assert(cancelCall && cancelCall.status === 200 && cancelCall.result?.result?.action === "cancel" && cancelCall.result.result.requested === true && cancelCall.body.owner?.nativeSessionId === primary, `Cancel did not travel as a guarded production request: ${JSON.stringify(cancelCall)}`);
    const settledB = await control({ op: "waitJob", sessionId: primary, jobId: "app-b", settled: true });
    assert(settledB.status === "cancelled" && settledB.consumed === false, `Native cancel did not settle the queued child as cancelled: ${JSON.stringify(settledB)}`);
    const cancelled = await refresh("app-b cancelled");
    const rowB = rowOf(cancelled, "app-b");
    assert(rowB?.status === "cancelled" && rowB.group === "recent" && rowB.qualifier && !rowB.cancel, `Cancelled row lacks recent placement or qualification: ${JSON.stringify(rowB)}`);
    checks.push(`Cancel control sent a guarded cancel (owner ${cancelCall.body.owner.nativeSessionId.slice(0, 8)}…, target ${cancelCall.body.job.id}/${cancelCall.body.job.startTime}); native accepted it before the body settled; UI states the request does not confirm settlement`);
    await capture("03-cancelled");

    await control({ op: "release", name: "app-a" });
    const completedA = await control({ op: "waitJob", sessionId: primary, jobId: "app-a", status: "completed" });
    const completed = await refresh("app-a completed");
    assert(rowOf(completed, "app-a")?.status === "completed" && rowOf(completed, "app-a").group === "recent" && rowOf(completed, "app-a").inspect, `Completed row missing: ${JSON.stringify(completed.rows)}`);
    const consumedBefore = (await control({ op: "job", sessionId: primary, jobId: "app-a" })).consumed;
    const beforeInspect = jobsCalls().length;
    await clickButton("Inspect output of app-a");
    const inspected = await wait(value => value.details.some(detail => detail.id === "app-a" && detail.kind === "result"), "inspected output for app-a");
    const inspectCall = jobsCalls().slice(beforeInspect).find(call => call.body.action === "inspect" && call.body.job?.id === "app-a");
    const consumedAfter = (await control({ op: "job", sessionId: primary, jobId: "app-a" })).consumed;
    const detailA = inspected.details.find(detail => detail.id === "app-a");
    assert(detailA.text.includes(context.childResult) && inspectCall?.status === 200 && inspectCall.result?.result?.detail?.resultText?.includes(context.childResult), `Inspected output is not the real child result: ${JSON.stringify(detailA)}`);
    assert(consumedBefore === consumedAfter && detailA.consumed === String(consumedAfter) && completedA.resultText.includes(context.childResult), `UI inspection changed native consumption (${consumedBefore} → ${consumedAfter}) or misreports it (${detailA.consumed}).`);
    checks.push(`Inspect control read the real child's retained output through the production route without consuming it (native consumed=${consumedAfter} before and after)`);
    await capture("04-inspected");
    await clickButton("Close output of app-a");

    await control({ op: "spawnTask", sessionId: primary, name: "app-c" });
    await control({ op: "awaitReached", name: "app-c" });
    await control({ op: "fail", name: "app-c" });
    const failedC = await control({ op: "waitJob", sessionId: primary, jobId: "app-c", status: "failed" });
    const failed = await refresh("app-c failed");
    assert(rowOf(failed, "app-c")?.status === "failed" && rowOf(failed, "app-c").group === "recent", `Failed row missing: ${JSON.stringify(failed.rows)}`);
    await clickButton("Inspect output of app-c");
    const failedDetail = await wait(value => value.details.some(detail => detail.id === "app-c" && detail.kind === "error"), "inspected error for app-c");
    assert(failedDetail.details.find(detail => detail.id === "app-c").text.includes("controlled child failure") && failedC.errorText.includes("controlled child failure"), "Failed child error text is not the real yield failure.");
    checks.push("A real child that yields an error settles the original job as failed and its error text is inspectable");
    await capture("05-failed");
    await clickButton("Close output of app-c");
    await control({ op: "spawnTask", sessionId: primary, name: "app-d" });
    await control({ op: "awaitReached", name: "app-d" });
    const heldAtLoss = await refresh("app-d running before owner loss");
    assert(rowOf(heldAtLoss, "app-d")?.status === "running" && rowOf(heldAtLoss, "app-d").cancel && !rowOf(heldAtLoss, "app-d").cancel.disabled, "A live cancellable row is required before owner loss.");

    const workersBefore = await control({ op: "workers" });
    const primaryPid = workersBefore.find(worker => worker.sessionId === primary && worker.captured)?.pid;
    assert(primaryPid, "The original primary worker must be captured before owner loss.");
    const lost = await control({ op: "restartHost" });
    assert(lost.hostId === connection.hostId && lost.liveWorkers === 0 && lost.retiredWorkerPids.includes(primaryPid), `Host restart did not retire every original worker: ${JSON.stringify(lost)}`);
    // The App reconnects to the same host id on its own; only then can its Refresh reach the restarted host.
    const beforeLoss = jobsCalls().length;
    let lastRefresh = 0;
    const stale = await bounded(async () => {
      const current = await state();
      if (!current.panel) return null;
      // One real Refresh per second until the restarted host answers; every attempt stays in the transport log.
      if (Date.now() - lastRefresh > 1_000 && current.refresh && !current.refresh.disabled && jobsCalls().slice(beforeLoss).every(call => call.done)) {
        lastRefresh = Date.now();
        await clickButton("Refresh background jobs");
      }
      const value = await state();
      return value.panel && value.panel.stale === "true" && value.notes.some(note => note.kind === "stale") && value.rows.length > 0 && value.rows.every(row => row.stale && (!row.cancel || row.cancel.disabled))
        && jobsCalls().slice(beforeLoss).some(call => call.status === 409) ? value : null;
    }, "stale retained rows after owner loss", 90_000);
    const lossCall = jobsCalls().slice(beforeLoss).find(call => call.status === 409);
    assert(["OWNER_UNAVAILABLE", "STALE_OWNER"].includes(lossCall.result?.error?.code), `Owner loss did not refuse the original jobs owner: ${JSON.stringify(jobsCalls().slice(beforeLoss))}`);
    assert(stale.rows.map(row => row.id).sort().join() === "app-a,app-b,app-c,app-d", `Stale panel did not retain the last same-owner rows: ${JSON.stringify(stale.rows)}`);
    assert(rowOf(stale, "app-d")?.status === "running" && rowOf(stale, "app-d").cancel?.disabled, "Retained running row must refuse cancellation after owner loss.");
    checks.push(`Owner loss (host restarted cleanly on ${lost.origin}; original worker ${primaryPid} retired) surfaces ${lossCall.result.error.code}; last known rows retained, labelled stale, running-job cancellation disabled. Other App observers may load a replacement, but Jobs remains pinned to the original owner.`);
    await capture("06-owner-lost");

    await clickTarget(`document.querySelector('.session-row[data-session-id="${other}"]')`, "other conversation row");
    const otherEmpty = await wait(value => value.sessionId === other && value.panel && value.panel.busy === "false" && value.panel.stale === "false" && value.rows.length === 0 && value.notes.some(note => note.kind === "empty"), "other conversation shows its own empty native jobs", 45_000);
    assert(jobsCalls().some(call => call.path.includes(encodeURIComponent(other)) && call.status === 200), "Other conversation jobs read did not reach its own worker.");
    checks.push("Switching conversations clears cross-session state synchronously; the other conversation's own worker reports supported-empty");
    await capture("07-other-empty");

    await clickTarget(`document.querySelector('.session-row[data-session-id="${primary}"]')`, "primary conversation row");
    const revived = await wait(value => value.sessionId === primary && value.panel && value.panel.busy === "false" && value.panel.stale === "false" && value.rows.length === 0 && value.notes.some(note => note.kind === "empty"), "revived primary conversation shows a cold empty native manager", 60_000);
    const workersAfter = await control({ op: "workers" });
    const replacement = workersAfter.find(worker => worker.sessionId === primary && worker.captured);
    assert(replacement && replacement.pid !== primaryPid && !workersBefore.some(worker => worker.pid === replacement.pid), `No fresh worker captured the revived primary session: ${JSON.stringify(workersAfter)}`);
    assert(revived.rows.length === 0, "Cold native manager restored rows that cannot exist.");
    checks.push(`Reselecting the conversation reads a fresh worker (${replacement.pid}); its cold manager is empty — no restoration of ${stale.rows.length} lost rows`);
    await capture("08-no-restoration");
    passed = true;
  } catch (cause) {
    failure = { message: String(cause?.stack ?? cause), time: Date.now() };
    try { failure.state = await state(); await capture("failure"); } catch (inner) { failure.captureError = String(inner); }
  } finally {
    const inference = await control({ op: "inference" }).catch(error => ({ error: String(error) }));
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed, failure, pauseForBrowser, pausedMs, checks, captures: captures.map(capture => capture.label), calls, controls, inputs, errors, inference,
      source: { main: createHash("sha256").update(readFileSync(join(repository, "apps/desktop/dist/main.cjs"))).digest("hex"), preload: createHash("sha256").update(readFileSync(join(repository, "apps/desktop/dist/preload.cjs"))).digest("hex") },
      scope: "Actual production App/main/preload/versioned transport, real host jobs route and production worker RPC over the ORIGINAL native session; every job is a real detached task child spawned by the original task tool against a loopback controlled provider. Electron sendInputEvent pointer input and read-only transport observation. Hidden-window captures unless paused; no reference pixel parity, provider, or physical-device claim." }, null, 2));
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy();
    app.exit(passed ? 0 : 1);
  }
}
require(join(repository, "apps/desktop/dist/main.cjs"));
