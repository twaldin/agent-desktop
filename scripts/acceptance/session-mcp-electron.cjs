const{app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));app.setPath('userData',launch.profile);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.setContentSize(1440,1000);
 const run=s=>win.webContents.executeJavaScript(s,true),captures=[];
 const wait=code=>run('window.acceptanceWait('+JSON.stringify(code)+')');
 const click=async(selector,text)=>{const p=await run('window.acceptanceTarget('+JSON.stringify(selector)+','+JSON.stringify(text)+')');const x=Math.round(p.x),y=Math.round(p.y);win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});};
 const capture=async name=>{const image=await win.webContents.capturePage();fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());captures.push({name,raster:image.getSize(),frame:win.getBounds(),content:win.getContentBounds(),zoom:win.webContents.getZoomFactor(),state:await run('window.acceptanceState()')});};
 try {
  await win.loadFile(path.join(output,'web/index.html'),{query:{endpoint:launch.endpoint,sessionId:launch.sessionId}});win.webContents.focus();
  await wait(`document.body.innerText.includes('fixture') && [...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('01-native-connected');
  await click('summary','Tools');await wait(`document.body.innerText.includes('mcp__fixture_tool')`);await capture('02-native-tools');
  await click('button','Reload servers');await wait(`document.body.innerText.includes('Reloading')`);await capture('03-native-reloading');
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('04-native-reloaded');
  await win.webContents.reload();await wait(`document.body.innerText.includes('fixture') && [...document.querySelectorAll('button')].some(x=>x.textContent==='Reload servers'&&!x.disabled)`);await capture('05-page-reopen-no-replay');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,electron:process.versions.electron,hidden:true,captures},null,2));app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),captures},null,2));app.exit(1);}
});
