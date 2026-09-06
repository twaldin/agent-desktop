const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));
app.setPath('userData',launch.profile);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.setContentSize(1440,1000);
 const evaljs=s=>win.webContents.executeJavaScript(s,true),captures=[],checks=[];
 const wait=code=>evaljs('window.acceptanceWait('+JSON.stringify(code)+')');
 const click=async(selector,text)=>{const p=await evaljs('window.acceptanceTarget('+JSON.stringify(selector)+','+JSON.stringify(text)+')'),z=win.webContents.getZoomFactor(),x=Math.round(p.x*z),y=Math.round(p.y*z);win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await sleep(100)};
 const type=async text=>{await win.webContents.insertText(text);await sleep(100)};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await sleep(100)};
 const capture=async name=>{const img=await win.webContents.capturePage();fs.writeFileSync(path.join(output,name+'.png'),img.toPNG());captures.push({name,raster:img.getSize(),frame:win.getBounds(),content:win.getContentBounds(),zoom:win.webContents.getZoomFactor(),state:await evaljs('window.acceptanceState()')});};
 let step='load';try{
  await win.loadFile(path.join(output,'web/index.html'),{query:{endpoint:launch.endpoint}});win.webContents.focus();
  await wait(`document.querySelector('.integration-list button')?.textContent.includes('Fixture plugin')`);await capture('01-plugin-list');
  await click('.integration-list button');await wait(`document.querySelector('[aria-label="token value"]')`);await capture('02-plugin-detail');
  step='secret';await click('[aria-label="token value"]');await type('UI_REPLACEMENT');
  await click('.integration-setting:has([aria-label="token value"]) button','Save');await wait(`document.querySelector('[aria-label="token value"]').value === '' && document.querySelector('[aria-label="token value"]').placeholder.startsWith('Configured')`);checks.push('Explicit secret Save reaches native registry and clears replacement text');
  step='enum';await evaljs(`document.querySelector('[aria-label="mode value"]').focus()`);win.webContents.sendInputEvent({type:'keyDown',keyCode:'e'});win.webContents.sendInputEvent({type:'char',keyCode:'e'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'e'});await sleep(150);await wait(`document.querySelector('[aria-label="mode value"]').value === 'expanded'`);await click('.integration-setting:has([aria-label="mode value"]) button','Save');await sleep(250);await capture('03-plugin-saved');
  step='mcp';await click('[role="tab"]','MCPs');await wait(`document.querySelector('.mcp-row')?.textContent.includes('disabled-fixture')`);await capture('04-mcp-list');await click('button','Add MCP');
  await click('.mcp-add label input');await type('ui-fixture');await click('[aria-label="Command to launch"]');await type('/bin/false');await capture('05-mcp-add');await click('.mcp-add button','Save');
  await wait(`document.querySelector('.mcp-catalog')?.textContent.includes('ui-fixture')`);await capture('06-mcp-saved');checks.push('MCP add through native form persists its server and returns to catalog');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,captures,checks,electron:process.versions.electron,hidden:true},null,2));app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,step,error:String(error),captures,checks,state:await evaljs('window.acceptanceState()').catch(()=>null)},null,2));app.exit(1);}
});
