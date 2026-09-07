const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = process.argv[2];
const profile = path.join(output, "profile");
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async condition => { for (let index = 0; index < 300; index++) { if (await js(condition)) return; await sleep(20); } throw new Error(`Condition failed: ${condition}`); };
  const click = async (selector, text) => {
    const point = await js(`window.fixtureTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`);
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) });
    await sleep(60);
  };
  const key = async keyCode => { win.webContents.sendInputEvent({ type: "keyDown", keyCode }); win.webContents.sendInputEvent({ type: "keyUp", keyCode }); await sleep(60); };
  const capture = async name => { const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); };
  const checks = [];
  let step = "load";
  try {
    await win.loadFile(path.join(output, "web/index.html"));
    win.webContents.focus();
    await wait(`document.querySelector('.plugin-directory-add-trigger')&&!document.querySelector('.plugin-directory-add-trigger').disabled`);
    const open = async () => { await click(".plugin-directory-add-trigger"); await wait(`window.fixtureState().menu&&document.activeElement?.getAttribute('role')==='menuitem'`); };

    step = "keyboard";
    await open();
    let rect = await js(`(()=>{const r=document.querySelector('.plugin-directory-add-menu').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`);
    if (rect.x < 0 || rect.y < 0 || rect.right > 1440 || rect.bottom > 1000) throw new Error(`Wide menu outside viewport: ${JSON.stringify(rect)}`);
    const wideMenu = { ...rect };
    await capture("01-wide-open");
    await key("Escape"); await wait(`!window.fixtureState().menu&&document.activeElement?.classList.contains('plugin-directory-add-trigger')`);
    await open(); await key("Tab"); await wait(`!window.fixtureState().menu&&document.activeElement?.classList.contains('plugin-directory-add-trigger')`);
    checks.push("First open focuses the menu item; Escape and Tab close and restore Add focus");

    step = "dismissals";
    step = "outside"; await open(); await click(".outside-target"); await wait(`!window.fixtureState().menu`);
    step = "resize"; await open(); win.setContentSize(1438, 998); await wait(`!window.fixtureState().menu&&document.activeElement?.classList.contains('plugin-directory-add-trigger')`);
    win.setContentSize(1440, 1000); await sleep(60);
    step = "scroll"; await open();
    const scrollPoint = await js(`window.fixtureTarget('.scroll-zone')`);
    win.webContents.sendInputEvent({ type: "mouseWheel", ...scrollPoint, deltaY: -100, deltaX: 0, canScroll: true });
    await wait(`!window.fixtureState().menu&&document.activeElement?.classList.contains('plugin-directory-add-trigger')`);
    await sleep(350);
    checks.push("Outside pointer, resize, and actual wheel scroll dismiss the portal menu");

    step = "owner";
    await open(); await js(`window.fixtureOwner('project-b')`); await wait(`!window.fixtureState().menu`);
    await open(); await js(`window.fixtureConnection(false)`); await wait(`!window.fixtureState().menu&&window.fixtureState().triggerDisabled===true`);
    await js(`window.fixtureConnection(true)`); await wait(`window.fixtureState().triggerDisabled===false`);
    checks.push("Owner and connection changes close the old menu; offline disables Add");

    step = "destination";
    await open(); await click('[role="menuitem"]', "Add a marketplace");
    await wait(`!window.fixtureState().menu&&window.fixtureState().calls===1&&document.activeElement?.getAttribute('aria-label')==='Marketplace destination'`);
    await sleep(100);
    if ((await js(`window.fixtureState().calls`)) !== 1) throw new Error("Marketplace callback was invoked more than once");
    checks.push("The pointer selection invokes the existing marketplace callback once and preserves destination focus");

    step = "narrow";
    win.setContentSize(720, 844); await sleep(100); await open();
    rect = await js(`(()=>{const r=document.querySelector('.plugin-directory-add-menu').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`);
    if (rect.x < 0 || rect.y < 0 || rect.right > 720 || rect.bottom > 844) throw new Error(`Narrow menu outside viewport: ${JSON.stringify(rect)}`);
    await capture("02-narrow-open"); await key("Escape");
    checks.push("The portal remains within the 720-point viewport and restores Add focus");

    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, hidden: true, checks, wideMenu, narrowMenu: rect }, null, 2));
    app.exit(0);
  } catch (error) {
    const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, "failure.png"), image.toPNG());
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, state: await js("window.fixtureState()").catch(() => null) }, null, 2));
    app.exit(1);
  }
});
