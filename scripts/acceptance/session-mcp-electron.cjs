const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));app.setPath('userData',launch.profile);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.setContentSize(1440,1000);
 win.webContents.session.on('will-download',(_event,item)=>item.setSavePath(path.join(output,'resource-download.bin')));
 const run=s=>win.webContents.executeJavaScript(s,true),captures=[];
 const wait=code=>run('window.acceptanceWait('+JSON.stringify(code)+')');
 const click=async(selector,text)=>{const p=await run('window.acceptanceTarget('+JSON.stringify(selector)+','+JSON.stringify(text)+')');const x=Math.round(p.x),y=Math.round(p.y);win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});};
 const capture=async name=>{const image=await win.webContents.capturePage();fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());captures.push({name,raster:image.getSize(),frame:win.getBounds(),content:win.getContentBounds(),zoom:win.webContents.getZoomFactor(),state:await run('window.acceptanceState()')});};
 try {
  await win.loadFile(path.join(output,'web/index.html'),{query:{endpoint:launch.endpoint,sessionId:launch.sessionId}});win.webContents.focus();
  await wait(`document.body.innerText.includes('fixture') && [...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('01-native-connected');
  await click('summary','Tools');await wait(`document.body.innerText.includes('mcp__fixture_tool')`);await capture('02-native-tools');
  await click('summary','Resources');await wait(`document.body.innerText.includes('fixture://{id}') && document.body.innerText.includes('text/plain')`);await capture('02a-native-resources');
  await click('button','Open resource');await wait(`document.querySelector('dialog[open]')`);await capture('02a1-resource-ready');
  await click('button','Read resource');await wait(`document.querySelector('.mcp-resource-contents pre')?.textContent==='Fixture contents for fixture://resource'`);await capture('02a2-resource-text');
  await click('#mcp-resource-uri');win.webContents.selectAll();await win.webContents.insertText('fixture://binary');await wait(`document.querySelector('#mcp-resource-uri').value==='fixture://binary'`);
  await click('button','Read resource');await wait(`document.body.innerText.includes('Binary resource · 4 bytes')`);await capture('02a3-resource-binary');
  win.setContentSize(390,844);await wait(`innerWidth===390`);await capture('02a4-narrow-resource');if(await run(`document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth`))throw new Error('Resource dialog overflows horizontally');win.setContentSize(1440,1000);await wait(`innerWidth===1440`);
  await click('a','Download');for(let i=0;i<100&&!fs.existsSync(path.join(output,'resource-download.bin'));i++)await new Promise(r=>setTimeout(r,20));if(!fs.readFileSync(path.join(output,'resource-download.bin')).equals(Buffer.from([0,1,2,255])))throw new Error('Resource download bytes differ');
  await click('#mcp-resource-uri');win.webContents.selectAll();await win.webContents.insertText('fixture://missing');await wait(`document.querySelector('#mcp-resource-uri').value==='fixture://missing'`);await click('button','Read resource');await wait(`document.querySelector('dialog [role=alert]')?.textContent.includes('could not be read')`);await capture('02a5-resource-unavailable');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});await wait(`!document.querySelector('dialog[open]')`);await wait(`document.activeElement?.textContent==='Open resource'`);
  await click('summary','Prompts');await wait(`document.body.innerText.includes('/fixture:fixture_prompt') && document.body.innerText.includes('Subject for this prompt') && document.body.innerText.includes('Required')`);await capture('02b-native-prompts');
  await click('summary','Notifications');await wait(`document.body.innerText.includes('Tool list changes') && document.body.innerText.includes('Resource subscriptions')`);await capture('02c-native-notifications');
  win.setContentSize(390,844);await wait(`innerWidth===390`);await capture('02d-narrow-details');if(await run('document.documentElement.scrollWidth>innerWidth'))throw new Error('MCP detail page overflows horizontally');
  win.setContentSize(1440,1000);await wait(`innerWidth===1440`);
  await click('button','Reload servers');await wait(`document.body.innerText.includes('Reloading')`);await capture('03-native-reloading');
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('04-native-reloaded');
  await win.webContents.reload();await wait(`document.body.innerText.includes('fixture') && [...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('05-page-reopen-no-replay');
  await click('button[aria-label="Reconnect fixture"]');await wait(`document.body.innerText.includes('Reconnecting…')`);await capture('06-native-reconnecting');
  await wait(`[...document.querySelectorAll('button')].some(x=>x.getAttribute('aria-label')==='Reconnect fixture'&&!x.disabled)`);await capture('07-native-reconnected');
  await win.webContents.reload();await wait(`[...document.querySelectorAll('button')].some(x=>x.getAttribute('aria-label')==='Reconnect fixture'&&!x.disabled)`);await capture('08-reconnect-page-reopen-no-replay');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,electron:process.versions.electron,hidden:true,captures},null,2));app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),captures},null,2));app.exit(1);}
});
