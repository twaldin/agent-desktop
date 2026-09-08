const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const output = process.argv[2];
const launch = JSON.parse(fs.readFileSync(path.join(output, 'launch.json'), 'utf8'));
app.setPath('userData', launch.profile);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width:1100, height:760, useContentSize:true, show:false,
    webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false} });
  const js = source => win.webContents.executeJavaScript(source);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], network = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (!/^(file|data|devtools):/.test(details.url)) network.push(details.url);
    callback({cancel:/^https?:/.test(details.url)});
  });
  async function wait(source) {
    for(let i=0; i<400; i++) { if(await js(source).catch(()=>false)) return; await sleep(25); }
    throw Error('Condition failed: '+source);
  }
  async function pointer(selector, double=false) {
    const point = await js(`window.target(${JSON.stringify(selector)})`);
    win.webContents.sendInputEvent({type:'mouseMove', ...point});
    // Both down/up pairs use the same physical position. The first click may replace a preview.
    for(let count=1; count <= (double?2:1); count++) {
      for(const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type, ...point, button:'left', clickCount:count});
      await sleep(40);
    }
    await sleep(80);
  }
  async function capture(name) {
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await sleep(100);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());
    const ax = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    fs.writeFileSync(path.join(output,name+'.ax.json'),JSON.stringify(ax,null,2));
    captures.push({name,raster:image.getSize(),state:await js('window.state()')});
  }
  let step='load';
  try {
    win.webContents.debugger.attach('1.3');
    await win.loadFile(path.join(output,'web/index.html')); win.webContents.focus();
    await pointer('.fixture-open-a');
    await wait('window.state().tabs?.length===1&&window.state().tabs[0].preview');
    await capture('01-preview-a');
    step='replace'; await pointer('.fixture-open-b');
    await wait('window.state().tabs?.length===1&&window.state().tabs[0].path==="b.md"&&window.state().tabs[0].preview');
    checks.push('Single clicks replace the clean preview in the destination pane');
    await capture('02-preview-b-replaced');
    step='tab-pin'; await pointer('[data-dock-tab-id][role="tab"]',true);
    await wait('!window.state().tabs[0].preview');
    checks.push('Two native click pairs on the preview tab promote it');
    await capture('03-tab-pinned');
    step='reference-pin'; await pointer('.transcript-file-reference',true);
    await wait('window.state().tabs?.some(tab=>tab.path==="a.md"&&!tab.preview)');
    checks.push('Two native click pairs on a transcript reference open a persistent file');
    await capture('04-reference-pinned');
    step='tree-double-click'; await pointer('.fixture-open-c');
    await wait('window.state().tabs?.some(tab=>tab.path==="nested/c.md"&&tab.preview)');
    const expanded = await js(`[...document.querySelectorAll('.workspace-file-tree-row[title="nested"]')].find(node=>node.getClientRects().length)?.getAttribute('aria-expanded')`);
    if(expanded !== 'true') await pointer('.workspace-file-tree-row[title="nested"]');
    await wait(`[...document.querySelectorAll('.workspace-file-tree-row[title="nested/d.md"]')].some(node=>node.getClientRects().length)`);
    if(!await js('window.state().tabs.some(tab=>tab.path==="nested/c.md"&&tab.preview)')) throw Error('Tree interaction promoted the preview');
    await pointer('.workspace-file-tree-row[title="nested/d.md"]',true);
    await wait('window.state().tabs?.some(tab=>tab.path==="nested/d.md"&&!tab.preview)&&!window.state().tabs?.some(tab=>tab.path==="nested/c.md")');
    checks.push('Tree navigation remains exempt; real double click replaces then pins its target');
    await capture('05-tree-double-click-pinned');
    const treeRows=await js(`[...document.querySelectorAll('.workspace-file-tree-row')].filter(node=>node.getClientRects().length).map(node=>{const svg=node.querySelector('svg'), r=node.getBoundingClientRect(), i=svg.getBoundingClientRect();return{path:node.title,level:node.getAttribute('aria-level'),row:{x:r.x,height:r.height},icon:{x:i.x,width:i.width,height:i.height},iconCount:node.querySelectorAll('svg').length,token:svg.getAttribute('data-icon-token'),fontSize:getComputedStyle(node).fontSize}})`);
    for(const row of treeRows)if(row.iconCount!==1||row.row.height!==28||row.icon.width!==16||row.fontSize!=='13px')throw Error('Tree row geometry or icon slot mismatch');
    const rootRow=treeRows.find(row=>row.path==='nested'),childRow=treeRows.find(row=>row.path==='nested/d.md');
    if(!rootRow||!childRow||childRow.icon.x-rootRow.icon.x!==17.5||childRow.token!=='markdown')throw Error('Tree indentation or file token mismatch');
    fs.writeFileSync(path.join(output,'tree-row-observations.json'),JSON.stringify(treeRows,null,2));
    checks.push('Production tree rows use one 16px icon, 28px height, 13px type and 17.5px depth indent');
    step='editor-edit'; await pointer('.fixture-open-c');
    await wait('window.state().tabs?.some(tab=>tab.path==="nested/c.md"&&tab.preview)');
    await pointer('.rich-markdown-file .cm-content');
    await wait('window.state().tabs?.some(tab=>tab.path==="nested/c.md"&&!tab.preview)');
    await win.webContents.insertText('x');
    await wait('window.state().documents.some(doc=>doc.path==="nested/c.md"&&doc.dirty&&doc.text.includes("x"))');
    checks.push('Editor pointer promotes before actual text input; edited buffer retained');
    await capture('06-editor-promoted');
    step='persist'; await pointer('.fixture-open-e');
    await wait('window.state().tabs.some(tab=>tab.path==="e.md"&&tab.preview)');
    if(await js('window.state().persistedTabs.some(tab=>tab.path==="e.md")')) throw Error('Transient preview persisted');
    await capture('07-transient-before-restore');
    const generation = await js('window.state().mountedGeneration');
    await js('window.reopen()');
    await wait(`window.state().mountedGeneration>${generation}&&window.state().tabs?.length===4&&!window.state().tabs.some(tab=>tab.preview||tab.path==="e.md")`);
    await wait('window.state().documents.some(doc=>doc.path==="nested/c.md"&&doc.text.includes("x"))');
    await wait(`[...document.querySelectorAll('.rich-markdown-file .cm-content')].filter(node=>node.getClientRects().length).some(node=>node.textContent.includes('initial C')&&node.textContent.includes('x'))`);
    checks.push('Real React unmount/remount from parsed saved dock omits the transient preview and restores four pinned tabs plus cached edited text');
    await capture('08-restored');
    const state=await js('window.state()');
    if(state.runtimeErrors.length) throw Error(JSON.stringify(state.runtimeErrors));
    if(network.length) throw Error('Unexpected network: '+JSON.stringify(network));
    const result={passed:true,checks,captures,network,zoom:win.webContents.getZoomFactor(),scope:'Hidden Electron production component composition with typed controlled workspace transport. React restoration, not an app restart. No installed, OS, provider or paired-pixel parity proof.'};
    fs.writeFileSync(path.join(output,'observed-baseline.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)); app.exit(0);
  } catch(error) {
    await capture('failure').catch(()=>{});
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,step,error:String(error),checks,captures,state:await js('window.state()').catch(()=>null)},null,2)); app.exit(1);
  }
});
