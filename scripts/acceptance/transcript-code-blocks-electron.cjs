const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile); app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 460, height: 700, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], consoleMessages = [], rendererGone = [];
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async source => { for (let i = 0; i < 1000; i++) { if (await js(source)) return; await sleep(25); } throw new Error("Condition failed: " + source); };
  const click = async (selector, label, index = 0) => { const point = await js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)},${index})`); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) }); await sleep(120); };
  const select = async (index, needle) => { const points = await js(`window.selectionPoints(${index},${JSON.stringify(needle)})`); win.webContents.sendInputEvent({ type: "mouseMove", ...points.start }); win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...points.start }); await sleep(50); win.webContents.sendInputEvent({ type: "mouseMove", button: "left", ...points.end }); await sleep(70); win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...points.end }); await sleep(120); };
  const capture = async name => { await sleep(100); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"), null, 2)); captures.push({ name, raster: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), zoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()") }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3"); await win.loadFile(path.join(output, "web/index.html")); win.webContents.focus();
    await wait("window.state?.().blocks.length===3&&window.state().blocks[0].highlighted==='true'&&window.state().blocks[2].highlighted==='true'");
    let state = await js("window.state()"), firstKey = state.blocks[0].key, secondKey = state.blocks[2].key;
    if (state.blocks[0].language !== "JavaScript" || state.blocks[1].language !== "MyDSL" || state.blocks[2].language !== "Python" || state.blocks[1].highlighted !== "false" || !state.blocks[0].buttons.some(item => item.label === "Copy code") || state.blocks[2].buttons.some(item => /Copy/.test(item.label)) || !state.blocks.every(item => item.buttons.some(button => button.label === "Enable word wrap" && button.pressed === "false")) || state.menuCount || state.dialogCount || state.overflow.documentWidth > 460 || state.blocks[0].scrollWidth <= state.blocks[0].clientWidth || !state.highlightPhases.some(item => item.highlighted === "false") || !state.highlightPhases.some(item => item.highlighted === "true")) throw new Error("Initial code-block contract differs: " + JSON.stringify(state));
    if (state.presentation.radius !== "20px" || state.presentation.labelSize !== "12px" || state.presentation.codeSize !== "12px" || state.presentation.codeLineHeight !== "20px" || state.presentation.string !== "rgb(131, 209, 151)" || state.presentation.keyword !== "rgb(248, 166, 200)" || state.presentation.comment !== "rgb(185, 185, 185)" || state.presentation.commentStyle !== "italic") throw new Error("Dark syntax presentation differs: " + JSON.stringify(state.presentation));
    await capture("00-narrow-closed-and-open-fence");
    checks.push("Actual MarkdownText first paints plain code then asynchronously tokenizes visible JavaScript and Python per block; unknown MyDSL keeps its case and plain source. Closed Copy is visible, the actively streaming incomplete fence hides Copy, wrap controls are independent, long code scrolls inside the 460px page, the toolbar/code typography and shell radius match their transcript tokens, and dark syntax colors plus italic comments match theme tokens; no unrelated action UI is invented");

    step = "completed-open-fence";
    await js("window.streaming(false)"); await wait("window.state().blocks[2].buttons.some(item=>item.label==='Copy code')"); state = await js("window.state()");
    if (state.blocks[2].key !== secondKey || state.blocks[2].text !== state.secondOriginal) throw new Error("Completed open-fence block identity/source changed: " + JSON.stringify(state.blocks[2]));
    await js("window.streaming(true)"); await wait("!window.state().blocks[2].buttons.some(item=>/Copy/.test(item.label))");
    checks.push("The same unterminated EOF fence exposes Copy when its message stops streaming, then hides Copy again when the controlled lifecycle resumes without changing block identity or source");

    step = "transcript-range-copy";
    const transcriptCopy = await js("window.copyTranscriptRange()");
    const expectedTranscriptCopy = `Before code.\n\n${state.firstOriginal}\n\nBetween blocks.`;
    const expectedRichCode = `<pre dir="ltr"><code>${state.firstOriginal}</code></pre>`;
    if (!transcriptCopy.prevented || transcriptCopy.plain !== expectedTranscriptCopy || !transcriptCopy.html.includes("<p>Before code.</p>") || !transcriptCopy.html.includes(expectedRichCode) || !transcriptCopy.html.includes("<p>Between blocks.</p>") || /JavaScript|Copy code|word wrap|<button/i.test(transcriptCopy.html) || (await js("window.state().clipboardCalls.length"))) throw new Error("Transcript range copy differs: " + JSON.stringify({ transcriptCopy, expectedTranscriptCopy, expectedRichCode }));
    checks.push("A controlled ClipboardEvent over a real paragraph-to-code-to-paragraph selection writes exact plain prose and code plus sanitized rich HTML without toolbar language/actions, and does not use navigator or the OS clipboard");

    step = "copy-failure-retry-reset";
    await click('button[aria-label="Copy code"]', "Copy code"); await wait("window.state().clipboardCalls.length===1&&Boolean(document.querySelector('button[aria-label=Copied]'))"); state = await js("window.state()");
    if (state.clipboardCalls[0].text !== state.firstOriginal) throw new Error("Closed block copy changed source bytes");
    await sleep(2100); await js("window.clipboardMode('failure')"); await click('button[aria-label="Copy code"]', "Copy code"); await wait("Boolean(document.querySelector('button[aria-label=\"Copy failed · retry\"]'))&&Boolean(document.querySelector('[role=alert]'))");
    if ((await js("window.state().clipboardCalls.length")) !== 1) throw new Error("Rejected copy recorded success");
    await js("window.clipboardMode('success')"); await click('button[aria-label="Copy failed · retry"]', "Copy failed · retry"); await wait("window.state().clipboardCalls.length===2&&Boolean(document.querySelector('button[aria-label=Copied]'))");
    checks.push("Real pointer Copy sends exact Unicode code text; copied status resets, an injected rejection shows an alert and retry control without recording success, and pointer Retry succeeds honestly");

    step = "stale-pending";
    await sleep(2100); await js("window.clipboardMode('pending')"); await click('button[aria-label="Copy code"]', "Copy code"); await wait("window.state().clipboardCalls.length===3&&window.state().clipboardCalls[2].state==='pending'");
    await js("window.updateFirst(true)"); await wait("window.state().blocks[0].text===window.state().firstUpdated&&!document.querySelector('button[aria-label=Copied]')"); state = await js("window.state()");
    if (state.blocks[0].key !== firstKey || !state.blocks[0].buttons.some(button => button.label === "Copy code" && button.busy === "true" && button.disabled && !button.inert)) throw new Error("Updated source did not retain the unresolved pending control: " + JSON.stringify(state.blocks[0]));
    await js("window.resolveClipboard()"); await wait("window.state().blocks[0].buttons.some(button=>button.label==='Copy code'&&button.busy==='false'&&!button.disabled)"); state = await js("window.state()");
    if (state.blocks[0].key !== firstKey || state.blocks[0].buttons.some(button => button.label === "Copied")) throw new Error("Stale pending copy or block identity changed: " + JSON.stringify(state.blocks[0]));
    secondKey = state.blocks[2].key;
    checks.push("A source update during a pending clipboard write retains block identity and keeps Copy disabled/pending until the old operation settles; completion restores idle without marking the new code Copied");

    step = "wrap-selection-stream-close";
    await click('button[aria-label="Enable word wrap"]', "Enable word wrap", 2); await wait("window.state().blocks[2].wrapped&&window.state().blocks[2].buttons.some(item=>item.label==='Disable word wrap'&&item.pressed==='true')");
    await select(2, '"café"\nprint'); await wait(`window.state().selection.text===${JSON.stringify('"café"\nprint')}`); state = await js("window.state()");
    if (state.selection.anchorBlock !== secondKey) throw new Error("Pointer selection belongs to the wrong block: " + JSON.stringify(state.selection));
    const selectionCopy = await js("window.copySelection(2)");
    if (selectionCopy.plain !== '"café"\nprint' || selectionCopy.html || !selectionCopy.prevented || (await js("window.state().clipboardCalls.length")) !== 3) throw new Error("Selection-only copy payload differs: " + JSON.stringify(selectionCopy));
    await js("window.appendSecond()"); await wait(`window.state().blocks[2].text===window.state().secondAppended&&window.state().selection.text===${JSON.stringify('"café"\nprint')}`);
    await js("window.closeSecond()"); await wait(`window.state().blocks[2].text===window.state().secondAppended&&window.state().selection.text===${JSON.stringify('"café"\nprint')}&&window.state().blocks[2].buttons.some(item=>item.label==='Copy code')`); state = await js("window.state()");
    if (state.blocks[2].key !== secondKey || !state.blocks[2].wrapped || state.blocks[2].buttons.some(button => button.label === "Enable word wrap") || state.blocks[2].whiteSpace !== "pre-wrap" || state.blocks[2].scrollWidth > state.blocks[2].clientWidth + 1) throw new Error("Streaming close lost wrap, selection or identity: " + JSON.stringify(state));
    await capture("01-open-fence-appended-and-closed");
    checks.push("A real pointer enables wrap on the incomplete block and selects text across syntax spans; its controlled ClipboardEvent writes only selected text/plain without using navigator or OS clipboard. Appending content and then closing the fence preserve block identity, exact selection and wrapped state while newly revealing Copy");

    step = "closed-second-copy-wide";
    await js("window.clipboardMode('success')"); await click('button[aria-label="Copy code"]', "Copy code", 2); await wait("window.state().clipboardCalls.length===4"); state = await js("window.state()");
    if (state.clipboardCalls[3].text !== state.secondAppended) throw new Error("Newly closed block copy differs: " + JSON.stringify(state.clipboardCalls[3]));
    win.setContentSize(1440, 1000); await wait("window.state().viewport.width===1440"); await js("window.theme('light')"); await wait("window.state().presentation.theme==='light'"); state = await js("window.state()");
    if (state.presentation.string !== "rgb(58, 132, 63)" || state.presentation.keyword !== "rgb(171, 79, 122)" || state.presentation.comment !== "rgb(79, 79, 79)" || state.presentation.commentStyle !== "italic") throw new Error("Light syntax presentation differs: " + JSON.stringify(state.presentation));
    await js("window.customString('rgb(1 2 3)')"); await wait("window.state().presentation.string==='rgb(1, 2, 3)'"); await capture("02-wide-light-custom-syntax");
    if (state.runtimeErrors.length || rendererGone.length || state.menuCount || state.dialogCount) throw new Error("Final code-block isolation failed: " + JSON.stringify({ state, rendererGone }));
    checks.push("After closing, real pointer Copy sends the complete appended Python source only; the wide light-theme view applies exact light syntax tokens and a controlled custom string token while retaining independent block state and no unrelated controls");
    state = await js("window.state()");
    const geometry = { narrow: { width: 460, height: 700 }, wide: { width: 1440, height: 1000 }, devicePixelRatio: state.viewport.dpr, zoomFactor: win.webContents.getZoomFactor(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), captureRasters: captures.map(item => ({ name: item.name, ...item.raster })) };
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2)); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, geometry, clipboardCalls: state.clipboardCalls, selectionCopies: state.selectionCopies, transcriptRangeCopy: transcriptCopy, highlightPhases: state.highlightPhases, presentation: state.presentation, blockKeys: { first: firstKey, second: secondKey }, selection: state.selection, hidden: true, actualProductionMarkdownText: true, fixtureClipboardBoundary: true, fixtureContextNotFullApp: true, nativeOsPixelParity: false, consoleMessages, rendererGone, scope: "Actual MarkdownText code blocks in hidden Electron with real pointer input, Chromium capturePage and Accessibility trees. Clipboard writeText and ClipboardEvent data are controlled at the fixture boundary; no OS clipboard, provider, Work, live Codex, host, installed integration, full App or native-window pixel parity claim." }, null, 2)); app.exit(0);
  } catch (error) { await capture("failure").catch(() => {}); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null), consoleMessages, rendererGone }, null, 2)); app.exit(1); }
});
