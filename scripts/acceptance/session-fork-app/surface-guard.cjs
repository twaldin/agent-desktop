const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { delimiter, join } = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');

/** Native identity and geometry are observed, never inferred from Electron's
 * requested bounds. The first drift latches failure for all later actions. */
function createSurfaceGuard({ window, output, fixture, conditions, http }) {
  const pid = process.pid, inspector = join(output, 'native-geometry');
  let windowId, displayId, themeBaseline, failed, prepared = false;
  const sameFrame = (left, right) => left && right && ['x', 'y', 'width', 'height'].every(key => left[key] === right[key]);
  const fail = (reason, observed) => {
    failed ??= { reason, observed, pid, windowId, conditions, time: new Date().toISOString() };
    writeFileSync(join(output, 'surface-failure.json'), JSON.stringify(failed, null, 2));
    throw new Error('Fork surface stopped: ' + failed.reason);
  };
  // AX requests need Electron's main thread; synchronously waiting here deadlocks their target.
  const native = async () => {
    try { return JSON.parse((await execute(inspector, [String(pid)], { encoding: 'utf8', timeout: 10_000 })).stdout); }
    catch (cause) { return fail('Native CG/AX inspection is unavailable.', { error: String(cause), stdout: String(cause.stdout ?? ''), stderr: String(cause.stderr ?? '') }); }
  };
  const tiler = async id => {
    let processIds;
    try { processIds = (await execute('/usr/bin/pgrep', ['-x', 'yabai'], { encoding: 'utf8', timeout: 5000 })).stdout.trim().split(/\s+/); }
    catch (cause) {
      if (cause.code === 1) return { running: false, processIds: [] };
      return fail('Cannot establish whether yabai manages this surface.', { error: String(cause), stderr: String(cause.stderr ?? '') });
    }
    try {
      const value = JSON.parse((await execute('yabai', ['-m', 'query', '--windows', '--window', String(id)], { encoding: 'utf8', timeout: 5000 })).stdout);
      if (value.id !== id || value.pid !== pid) return fail('The yabai window does not belong to the owned Electron PID.', value);
      return { running: true, processIds, window: value, bounds: { x: value.frame.x, y: value.frame.y, width: value.frame.w, height: value.frame.h } };
    } catch (cause) { return fail('The running yabai daemon cannot verify the owned window.', { error: String(cause), stderr: String(cause.stderr ?? '') }); }
  };
  const peers = async label => {
    try {
      const privateBin = join(fixture, 'bin'), refusal = readFileSync(join(privateBin, 'tailscale'), 'utf8');
      if (process.env.PATH?.split(delimiter)[0] !== privateBin || refusal !== '#!/bin/sh\nexit 1\n') return fail('The explicit private tailnet refusal boundary changed.');
      const network = await window.webContents.executeJavaScript('window.agentDesktop.getHosts()', true);
      appendFileSync(join(output, 'tailnet-isolation-checks.jsonl'), JSON.stringify({ label, pid, privateBin, refusalSHA256: createHash('sha256').update(refusal).digest('hex'), network, time: new Date().toISOString() }) + '\n');
      if (!network || !Array.isArray(network.hosts) || network.hosts.length !== 0 || network.status === 'connecting') return fail('Actual desktop discovery is not settled with zero remote peers; no UI writes are permitted.', network);
      return network;
    } catch (cause) { return fail('Actual desktop peer isolation could not be verified.', { error: String(cause) }); }
  };
  const geometry = async (label, requireFocus = true) => {
    if (failed) throw new Error('Fork surface stopped: ' + failed.reason);
    const observation = await native(), cg = observation.cgWindows?.find(value => value.id === windowId && value.pid === pid);
    const ax = observation.axWindows?.filter(value => sameFrame(value.frame, cg?.frame));
    const display = observation.displays?.find(value => value.id === displayId);
    const managed = await tiler(windowId);
    const viewport = await window.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport?.scale,cssZoom:getComputedStyle(document.documentElement).zoom,fullscreen:Boolean(document.fullscreenElement)})`, true);
    const observed = { label, native: observation, yabai: managed, viewport, electronBounds: window.getBounds(), contentBounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor(), fullscreen: window.isFullScreen(), time: new Date().toISOString() };
    appendFileSync(join(output, 'surface-checks.jsonl'), JSON.stringify(observed) + '\n');
    if (observation.pid !== pid || observation.axWindowsError !== 0 || observation.cgWindows?.length !== 1 || !cg || !sameFrame(cg.frame, conditions.bounds) || ax?.length !== 1 || ax[0].fullscreen !== false || ax[0].minimized !== false
      || !sameFrame(observed.electronBounds, conditions.bounds) || observed.fullscreen || viewport.fullscreen) return fail('Owned CG/AX/native bounds or fullscreen state drifted.', observed);
    if (!display || display.backingScaleFactor !== conditions.dpr || !(display.pixelWidth > 0 && display.pixelHeight > 0)
      || cg.frame.x < display.frame.x || cg.frame.y < display.frame.y || cg.frame.x + cg.frame.width > display.frame.x + display.frame.width || cg.frame.y + cg.frame.height > display.frame.y + display.frame.height) return fail('The owned window left its verified display/scale.', observed);
    const cssZoom = viewport.cssZoom === 'normal' ? 1 : Number(viewport.cssZoom);
    if (viewport.width !== conditions.viewport.width || viewport.height !== conditions.viewport.height || viewport.dpr !== conditions.dpr || viewport.scale !== 1 || cssZoom !== 1 || observed.zoom !== conditions.zoom
      || observed.contentBounds.width !== conditions.viewport.width || observed.contentBounds.height !== conditions.viewport.height) return fail('Actual content viewport, aspect, DPR or zoom drifted.', observed);
    if (managed.running && (managed.window['is-floating'] !== true || managed.window['is-native-fullscreen'] !== false || managed.window['is-minimized'] !== false || !sameFrame(managed.bounds, conditions.bounds))) return fail('The owned window was retiled or changed by yabai.', observed);
    if (requireFocus && (observation.frontmostPID !== pid || !window.isFocused())) return fail('The owned native window lost foreground ownership.', observed);
    return observed;
  };
  const check = async label => {
    try {
      if (failed) throw new Error('Fork surface stopped: ' + failed.reason);
      if (!prepared) return fail('Native surface ownership was not prepared before input/capture.');
      const network = await peers(label), observed = await geometry(label);
      const sourceTheme = await http('/v1/theme');
      const rendererTheme = await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;const root=getComputedStyle(document.documentElement),body=getComputedStyle(document.body),prompt=document.querySelector('#prompt'),input=prompt&&getComputedStyle(prompt);return {mode:document.documentElement.dataset.theme,material:document.documentElement.dataset.material,resolved:document.documentElement.dataset.resolvedTheme,prefersDark:matchMedia('(prefers-color-scheme: dark)').matches,fonts:document.fonts.status,bodyFont:body.fontFamily,bodySize:body.fontSize,promptFont:input?.fontFamily,promptSize:input?.fontSize,tokens:Object.fromEntries(['--app-surface','--text','--secondary','--font-size','--code-font-size','--menu-surface','--selected'].map(name=>[name,root.getPropertyValue(name).trim()]))};})()`, true);
      if (rendererTheme.fonts !== 'loaded' || !rendererTheme.bodyFont || !rendererTheme.promptFont || !rendererTheme.resolved || !sourceTheme?.document || sourceTheme.fileError) return fail('The source-resolved theme/fonts are not ready.', { rendererTheme, sourceTheme });
      const expectedVariant = sourceTheme.document.mode === 'system' ? rendererTheme.prefersDark ? 'dark' : 'light' : sourceTheme.document.mode;
      if (rendererTheme.mode !== sourceTheme.document.mode || rendererTheme.material !== sourceTheme.document.material || rendererTheme.resolved !== expectedVariant) return fail('The renderer theme does not resolve from the actual source theme document.', { rendererTheme, sourceTheme });
      const theme = { source: sourceTheme, renderer: rendererTheme, nativeBackground: window.getBackgroundColor() }, fingerprint = createHash('sha256').update(JSON.stringify(theme)).digest('hex');
      if (themeBaseline && themeBaseline.sha256 !== fingerprint) return fail('The verified source theme/font/token condition changed.', { previous: themeBaseline, current: { sha256: fingerprint, theme } });
      if (!themeBaseline) { themeBaseline = { sha256: fingerprint, theme }; writeFileSync(join(output, 'surface-theme-baseline.json'), JSON.stringify(themeBaseline, null, 2)); }
      const finalGeometry = await geometry(label + ':immediately-before-action');
      const proof = { ...finalGeometry, initialGeometry: observed, network, themeSHA256: fingerprint };
      appendFileSync(join(output, 'input-capture-conditions.jsonl'), JSON.stringify(proof) + '\n');
      return proof;
    } catch (cause) { return fail('Input/capture conditions could not be verified.', { error: String(cause) }); }
  };
  return {
    async prepare() {
      if (app.getPath('userData') !== join(fixture, 'profile')) return fail('The actual Electron profile is not the isolated fixture profile.', { userData: app.getPath('userData') });
      await peers('before-native-surface-writes');
      const observation = await native();
      if (observation.pid !== pid || observation.cgWindows?.length !== 1) return fail('Cannot uniquely bind the candidate native window to its owned PID.', observation);
      const cg = observation.cgWindows[0], ax = observation.axWindows?.filter(value => sameFrame(value.frame, cg.frame));
      if (observation.axWindowsError !== 0 || ax?.length !== 1 || ax[0].fullscreen !== false || ax[0].minimized !== false) return fail('The owned AX window is unavailable or fullscreen.', observation);
      windowId = cg.id;
      const display = observation.displays.find(value => conditions.bounds.x >= value.frame.x && conditions.bounds.y >= value.frame.y && conditions.bounds.x + conditions.bounds.width <= value.frame.x + value.frame.width && conditions.bounds.y + conditions.bounds.height <= value.frame.y + value.frame.height);
      if (!display) return fail('The requested fixed native case does not fit a single actual display.', observation);
      displayId = display.id;
      const managed = await tiler(windowId);
      if (managed.running && managed.window['is-native-fullscreen'] !== false) return fail('The owned yabai window is fullscreen.', managed);
      writeFileSync(join(output, 'surface-acquisition.json'), JSON.stringify({ pid, windowId, displayId, profile: app.getPath('userData'), requested: conditions,
        initialNative: observation, initialYabai: managed, action: managed.running ? managed.window['is-floating'] === true ? 'already-floating-owned-window' : 'float-only-owned-window' : 'isolated-owned-window-with-no-yabai-process' }, null, 2));
      if (managed.running && managed.window['is-floating'] !== true) await execute('yabai', ['-m', 'window', String(windowId), '--toggle', 'float'], { timeout: 5000 });
      window.setBounds(conditions.bounds, false);
      await new Promise(resolve => setTimeout(resolve, 100));
      await geometry('after-owned-float-and-fixed-bounds', false);
      window.focus();
      await new Promise(resolve => setTimeout(resolve, 100));
      await geometry('after-owned-focus');
      prepared = true;
      for (const event of ['resize', 'move', 'enter-full-screen', 'leave-full-screen']) window.on(event, () => {
        if (prepared && !failed && !window.isDestroyed()) void geometry('native-event:' + event).catch(cause => {
          try { fail('Native bounds could not be rechecked after a window event.', { event, error: String(cause) }); } catch { /* Failure remains latched; every later action is refused. */ }
        });
      });
    },
    check,
    async capture(label, file) {
      const before = await check(label + ':before-capture');
      const record = { label, file, qualified: false, before, referenceComparison: { matched: false, reason: 'No independently matched reference zoom/aspect/theme/profile conditions are supplied by this functional fixture.' } };
      try {
        await execute('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), file], { timeout: 15_000 });
        const png = readFileSync(file);
        if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return fail('Native capture did not produce an original PNG.', record);
        record.png = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
        if (record.png.width !== conditions.bounds.width * conditions.dpr || record.png.height !== conditions.bounds.height * conditions.dpr) return fail('Saved native PNG IHDR does not match the verified native frame and display scale.', record);
        record.after = await check(label + ':after-capture'); record.qualified = true; return record;
      } finally { appendFileSync(join(output, 'native-capture-conditions.jsonl'), JSON.stringify(record) + '\n'); }
    },
    conditions,
  };
}
module.exports = { createSurfaceGuard };
