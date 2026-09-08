const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));
app.setPath('userData',launch.profile);app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1440,height:1000,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const js=source=>win.webContents.executeJavaScript(source),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const checks=[],captures=[],consoleMessages=[];win.webContents.on('console-message',(...args)=>consoleMessages.push(args.slice(1).map(String).join(' | ')));
 const wait=async source=>{for(let i=0;i<400;i++){if(await js(source))return;await sleep(25);}throw Error('Condition failed: '+source);};
 const click=async(selector,label,button='left')=>{const p=await js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)})`);for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...p,...(type==='mouseMove'?{}:{button,clickCount:1})});await sleep(100);};
 const capture=async name=>{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,name+'.ax.json'),JSON.stringify(await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')));captures.push({name,state:await js('window.state()'),draft:await js('window.wholeDraft()')});};
 let step='load';
 try{
  await win.loadFile(path.join(output,'web','index.html'),{query:{endpoint:launch.endpoint,target:JSON.stringify(launch.target),hostId:launch.hostId,project:launch.project,wholeFiles:'true'}});
  win.webContents.focus();win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Accessibility.enable');
  await wait(`window.state().restored&&window.editor()`);await click('button[aria-label="Toggle file tree"]');
  await wait(`window.state().restored&&document.querySelector('[role="treeitem"][title="second.ts"]')`);
  const row='[role="treeitem"][title="second.ts"]';
  step='attach';await click(row,undefined,'right');await wait(`document.querySelector('.workspace-file-open-menu')?.textContent.includes('Add to chat')`);await capture('01-add-menu');
  await click('.workspace-file-open-menu [role="menuitem"]','Add to chat');await wait(`window.wholeDraft().status==='saved'&&document.querySelector('.composer-whole-file')`);
  const expected=launch.project+'/second.ts',saved=await js(`window.request('/test/whole-state',{})`);
  if(saved.draft.wholeFileAttachments.length!==1||saved.draft.wholeFileAttachments[0].source.path!==expected||saved.sessions!==0)throw Error('Wrong file intent '+JSON.stringify(saved));
  if(await js('document.activeElement?.id')!=='whole-file-text')throw Error('Composer focus not restored');
  await capture('02-file-chip');checks.push('Actual right-click Add to chat stages the clicked nonselected file, saves a v7 descriptor on its owner, and focuses composer without creating a session');
  step='deduplicate';await click(row,undefined,'right');await wait(`document.querySelector('.workspace-file-open-menu')?.textContent.includes('Add to chat')`);await click('.workspace-file-open-menu [role="menuitem"]','Add to chat');await wait(`window.wholeDraft().status==='saved'`);
  if((await js('window.wholeDraft().draft.wholeFileAttachments.length'))!==1)throw Error('Repeated file duplicated');checks.push('Adding the same host/path twice retains one identity');
  step='offline-reload';await js('window.connection(false)');await click('#whole-file-text');await win.webContents.insertText('UNSENT_WHOLE_FILE_DRAFT');await wait(`window.wholeDraft().draft.text==='UNSENT_WHOLE_FILE_DRAFT'&&window.wholeDraft().status==='offline'`);await capture('03-offline-draft');
  await win.webContents.reload();await wait(`window.wholeDraft?.().draft.text==='UNSENT_WHOLE_FILE_DRAFT'&&window.wholeDraft().status==='saved'`);
  if((await js('window.wholeDraft().draft.wholeFileAttachments[0].source.path'))!==expected)throw Error('File intent lost at reload');await capture('04-restored-draft');checks.push('Offline authored text and whole-file identity survive renderer reload and reconnect without Send');
  step='remove';await click('.composer-whole-file button');await wait(`window.wholeDraft().status==='saved'&&window.wholeDraft().draft.wholeFileAttachments.length===0`);
  const final=await js(`window.request('/test/whole-state',{})`);if(final.sessions!==0||final.draft.text!=='UNSENT_WHOLE_FILE_DRAFT'||final.draft.wholeFileAttachments.length!==0)throw Error('Remove lost authored draft');await capture('05-remove');checks.push('Removing the chip persists an empty sticky manifest while preserving authored text; zero sessions/prompts');
  if((await js('window.state().runtimeErrors')).length)throw Error('Renderer error');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,captures,final,electron:process.versions.electron,zoom:win.webContents.getZoomFactor(),scope:'Hidden renderer component with authenticated host; no native popup/window or pixel equivalence'},null,2));
 }catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,step,error:String(error.stack||error),checks,captures,consoleMessages,state:await js("window.state()").catch(()=>null)},null,2));process.exitCode=1;}
 finally{win.destroy();app.exit(process.exitCode||0);}
});
