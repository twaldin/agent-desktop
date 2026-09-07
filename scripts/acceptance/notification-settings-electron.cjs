const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));
app.setPath('userData',launch.profile);app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1440,height:1000,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}),captures=[],checks=[];
 const js=source=>win.webContents.executeJavaScript(source),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async source=>{for(let i=0;i<400;i++){if(await js(source))return;await sleep(25);}throw Error('Timed out: '+source);};
 const click=async selector=>{const p=await js(`window.target(${JSON.stringify(selector)})`);for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await sleep(100);};
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await sleep(100);};
 const capture=async name=>{const image=await win.webContents.capturePage();fs.writeFileSync(path.join(output,name+'.png'),image.toPNG());captures.push({name,raster:image.getSize(),frame:win.getBounds(),zoom:win.webContents.getZoomFactor(),state:await js('window.state()')});};
 try{
 await win.loadFile(path.join(output,'web/index.html'),{query:{endpoint:launch.endpoint,hostId:launch.hostId}});win.webContents.focus();
 await wait(`document.querySelector('[aria-label="Turn completion notifications"]:not(:disabled)')`);await capture('01-general-settings');
 await click('[aria-label="Turn completion notifications"]');await wait(`document.querySelector('[role="menu"]')`);await capture('02-completion-menu');
 if(await js(`JSON.stringify([...document.querySelectorAll('[role="menuitemradio"]')].map(n=>n.textContent))`)!==JSON.stringify(['Never','Only when unfocused','Always']))throw Error('Menu order');
 await wait(`document.activeElement?.getAttribute('aria-checked')==='true'`);await key('Down');await wait(`document.activeElement?.textContent==='Always'`);await key('Enter');await wait(`window.state().preferences?.completionPolicy==='always'&&!window.state().busy&&!window.state().pending`);checks.push('Real keyboard selection persists Always through the production preferences controller and authenticated host');
 await click('[aria-label="Turn completion notifications"]');await key('Home');await key('Enter');await wait(`window.state().preferences?.completionPolicy==='never'&&!window.state().busy`);
 await click('[aria-label="Enable permission notifications"]');await wait(`window.state().preferences?.approvalRequired===false&&!window.state().busy`);
 await click('[aria-label="Enable question notifications"]');await wait(`window.state().preferences?.questionRequired===false&&!window.state().busy`);await capture('03-disabled-notifications');
 checks.push('Never and independent question/permission toggles commit without prompts or OS notification calls');
 await new Promise(resolve=>{win.webContents.once("did-finish-load",resolve);win.webContents.reload();});await wait(`document.querySelector('[aria-label="Turn completion notifications"]:not(:disabled)')&&window.state().preferences?.completionPolicy==='never'`);
 if(!(await js(`window.state().preferences.approvalRequired===false&&window.state().preferences.questionRequired===false`)))throw Error('Reload lost preferences');
 await click('[aria-label="Turn completion notifications"]');await key('Down');await key('Escape');await wait(`!document.querySelector('[role="menu"]')&&document.activeElement?.getAttribute('aria-label')==='Turn completion notifications'`);
 await capture('04-reloaded-focus-return');checks.push('Reload preserves acknowledged preferences; Escape restores trigger focus without saving the highlighted option');
 const state=await js('window.state()');if(state.errors.length||state.error)throw Error(JSON.stringify(state));
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,captures,scope:'Production GeneralSettings/PreferencesState in hidden Electron with real authenticated isolated host persistence. Not installed main/preload or native OS alert/pixel parity proof.'},null,2));app.quit();
 }catch(error){await capture('failure');fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),checks,captures},null,2));app.exit(1);}
});
