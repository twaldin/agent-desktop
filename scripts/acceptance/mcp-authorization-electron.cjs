const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv[2],root=process.argv[3],ready=JSON.parse(fs.readFileSync(path.join(root,'ui-ready.json'),'utf8'));
const transport=require(path.join(output,'transport.cjs'));
app.setPath('userData',path.join(root,'electron-profile'));
let starts=0,answers=0,opened=0,callback='';
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:path.join(output,'preload.cjs')}});win.setContentSize(1440,1000);
 ipcMain.handle('fixture',async(event,name,...args)=>{
  if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('Unowned fixture sender');
  const owner=(id)=>{if(id!==ready.endpoint.hostId)throw new Error('Unowned fixture host');};
  if(name==='getSessionMcp'){owner(args[1]);return transport.requestSessionMcp(ready.endpoint,args[0],args[2]);}
  if(name==='getSessionMcpAuthorization'){owner(args[1]);return transport.requestSessionMcpAuthorization(ready.endpoint,args[0],args[2]);}
  if(name==='respondSessionMcpAuthorization'){owner(args[2]);answers++;return transport.respondSessionMcpAuthorization(ready.endpoint,args[0],args[1]);}
  if(name==='cancelSessionMcpAuthorization'){owner(args[2]);return transport.cancelSessionMcpAuthorization(ready.endpoint,args[0],args[1]);}
  if(name==='command'){owner(args[1]);if(args[0].command.type!=='session.mcp.authorize')throw new Error('Outside fixture command scope');starts++;return transport.requestHost(ready.endpoint,'/v1/commands',args[0]);}
  if(name==='openExternal'){const url=new URL(args[0]);if(url.origin!==ready.issuer)throw new Error('Unowned OAuth issuer');const redirect=new URL(url.searchParams.get('redirect_uri'));redirect.searchParams.set('state',url.searchParams.get('state'));redirect.searchParams.set('code','route-private-code');callback=redirect.toString();opened++;return;}
  throw new Error('Unknown fixture operation');
 });
 const run=s=>win.webContents.executeJavaScript(s,true),captures=[];
 const wait=async(s)=>{for(let i=0;i<300;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI state did not settle: '+s);};
 const click=async(text)=>{const p=await run(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw new Error('Unavailable button');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});};
 const capture=async(name)=>{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());captures.push({name,state:await run(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,font:getComputedStyle(document.body).fontFamily,text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth,inputs:[...document.querySelectorAll('input')].map(x=>({type:x.type,disabled:x.disabled,width:x.getBoundingClientRect().width})),storage:Object.keys(localStorage).map(key=>({key,value:localStorage.getItem(key)}))})`),zoom:win.webContents.getZoomFactor()});};
 try{
  await win.loadFile(path.join(output,'web/index.html'),{query:{hostId:ready.endpoint.hostId,sessionId:ready.sessionId}});win.webContents.focus();
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='Authenticate'&&!x.disabled)`);await capture('01-authenticate');
  await click('Authenticate');await wait(`document.querySelector('.secret-form input') && document.body.innerText.includes('Open sign-in page')`);await capture('02-pending');
  await win.webContents.reload();await wait(`document.querySelector('.secret-form input')`);if(starts!==1)throw new Error('Reload replayed authorization');
  win.setContentSize(390,844);await wait('innerWidth===390');await capture('03-narrow');if(captures.at(-1).state.overflow)throw new Error('Horizontal overflow');win.setContentSize(1440,1000);await wait('innerWidth===1440');
  await click('Open sign-in page');for(let i=0;i<100&&!opened;i++)await new Promise(r=>setTimeout(r,10));if(opened!==1||!callback)throw new Error('Authorization page not explicitly requested');
  const p=await run(`(()=>{const e=document.querySelector('.secret-form input');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+10,y:r.y+r.height/2};})()`);win.webContents.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});await win.webContents.insertText(callback);
  await click('Continue');await wait(`document.body.innerText.includes('Server connected')`);await capture('04-connected');
  await win.webContents.reload();await wait(`document.body.innerText.includes('Server connected')`);await capture('05-reopen');
  if(starts!==1||answers!==1)throw new Error('Duplicate operation');if(JSON.stringify(captures.map(x=>x.state.storage)).includes('route-private-code'))throw new Error('Private callback cached');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,starts,answers,opened,captures,scope:'Hidden Electron real renderer and production transport over fixture IPC, authenticated real host/native local MCP OAuth. No full-app IPC, native OS-window, hosted-provider or pixel-parity claim.'},null,2));fs.writeFileSync(path.join(root,'ui-done'),'done');app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),starts,answers,captures},null,2));app.exit(1);}
});
