const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const out=process.argv[2],endpoint=process.argv[4];
app.setPath('userData',path.join(out,'electron-profile'));
const checkpoints=[],errors=[];
const invoke=async(method,args=[])=>{const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});const v=await r.json();if(!r.ok)throw Error(v.fixtureError);return v};
app.whenReady().then(async()=>{
 let win,exit=1;
 ipcMain.handle('sidebar-fixture',(_event,method,args)=>invoke(method,args));
 try {
  win=new BrowserWindow({show:false,resizable:false,width:1150,height:1000,webPreferences:{contextIsolation:true,sandbox:true,preload:path.join(out,'preload.cjs')}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  const run=expr=>win.webContents.executeJavaScript(expr,true);
  const wait=async expr=>{for(let i=0;i<250;i++){if(await run(expr))return;await new Promise(r=>setTimeout(r,20))}throw Error('Not settled: '+expr+'\n'+await run('document.body.innerText'))};
  const byText=text=>`[...document.querySelectorAll('button')].find(n=>n.textContent.replace(/✓/g,'').trim()===${JSON.stringify(text)})`;
  const bySelector=selector=>`document.querySelector(${JSON.stringify(selector)})`;
  const click=async(text,selector,right=false)=>{
    const expr=selector?bySelector(selector):byText(text);
    await wait(`!!(${expr})&&!(${expr}).disabled`);
    for(let attempt=0;attempt<40;attempt++) {
      const b=await run(`(()=>{let e=${expr};if(!e)return null;e.scrollIntoView({block:'nearest'});return e.getBoundingClientRect().toJSON()})()`);
      if(!b){await new Promise(r=>setTimeout(r,30));continue;}
      const x=Math.round(b.x+Math.min(14,b.width/2)),y=Math.round(b.y+b.height/2);
      win.webContents.sendInputEvent({type:'mouseMove',x,y});await new Promise(r=>setTimeout(r,80));
      const stable=await run(`(()=>{const e=${expr},hit=document.elementFromPoint(${x},${y}),r=e?.getBoundingClientRect();return !!e&&!e.disabled&&r.y===${b.y}&&(hit===e||e.contains(hit))})()`);
      if(!stable)continue;
      for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x,y,button:right?'right':'left',clickCount:1});
      await new Promise(r=>setTimeout(r,80));return;
    }
    throw Error('No stable visible click target: '+(selector??text));
  };
  const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(r=>setTimeout(r,40))};
  const check=(v,m)=>{if(!v)throw Error(m)};
  const has=text=>`document.body.innerText.includes(${JSON.stringify(text)})`;
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'-geometry.json'),JSON.stringify({window:win.getBounds(),content:win.getContentBounds(),viewport:await run('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})')},null,2));fs.writeFileSync(path.join(out,name+'.txt'),await run('document.body.innerText'));fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());checkpoints.push(name)};
  const reopen=async()=>{await wait(`(()=>{const s=JSON.parse(document.querySelector('#preference-status').textContent);return !s.busy&&!s.pending})()`);const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));await click(null,'#reload');await loaded;await wait(has('Sidebar organization fixture'));};
  const options=async kind=>{await click(null,`[aria-label="${kind} sidebar options"]`);await wait(`!!document.querySelector('.sidebar-organization-menu')`)};
  const choice=async label=>{await click(label);await wait(`!document.querySelector('.sidebar-organization-menu')`) };
  const item=async title=>{const id=await run(`(()=>{let n=[...document.querySelectorAll('.session-row')].find(n=>n.textContent.trim()===${JSON.stringify(title)});return n&&{host:n.dataset.hostId,id:n.dataset.sessionId}})()`);if(!id)throw Error('Missing chat '+title);return `[data-session-id="${id.id}"][data-host-id="${id.host}"]`};
  const newSection=async name=>{await options('Chat');await click('New section');await wait(`document.querySelector('#sidebar-section-name')===document.activeElement`);await win.webContents.insertText(name);await click('Create section');await wait(`!!document.querySelector('section[aria-label="${name}"]')&&!document.querySelector('dialog[open]')`)};
  const moveToSection=async title=>{await click(null,await item(title),true);await click(null,'select[aria-label="Move item to section"]');await key('F');win.webContents.sendInputEvent({type:'char',keyCode:'f'});await key('Return');await wait(`!document.querySelector('.sidebar-organization-menu')`)};
  const archiveOpen=async()=>{await click(null,'[aria-label="Options for Focus"]');await click('Archive all chats');await wait(`!!document.querySelector('dialog[open]')`)};
  const archiveFinish=async()=>{await click('Archive chats');await wait(`!document.body.innerText.includes('Archiving…')`)};
  await win.loadFile(process.argv[3]);win.show();win.focus();win.webContents.focus();await new Promise(r=>setTimeout(r,200));win.setContentSize(1150,900);win.setPosition(40,40);await wait(has('Zebra project'));await shot('01-initial-icons');
  await options('Project');await choice('By project');await options('Project');await choice('Last updated');
  await wait(`document.querySelector('.project-label').textContent==='Alpha project'`);await shot('02-updated-project-order');
  await options('Project');await choice('Manual order');await click(null,'[aria-label="Project actions for Alpha project"]');await click('Move down');await wait(`document.querySelector('.project-label').textContent==='Zebra project'`);
  await click('Projects');await wait(`!document.querySelector('.project-group')`);await reopen();await wait(has('Sidebar organization fixture'));await wait(`!document.querySelector('.project-group')`);await click('Projects');await wait(`document.querySelector('.project-label').textContent==='Zebra project'`);await click('Zebra project');await wait(`document.querySelectorAll('.project-sessions .session-row').length===2`);await reopen();await wait(`document.querySelectorAll('.project-sessions .session-row').length===2`);await shot('03-manual-order-collapse-reopened');
  await options('Project');await choice('By connection');await wait(`document.querySelectorAll('.host-section-label').length===2`);await shot('04-by-connection');
  await options('Project');await choice('In one list');await click('Recents');await wait(`document.querySelectorAll('.session-row').length===6`);await options('Chat');await choice('Last updated');await wait(`document.querySelector('.session-row').textContent.trim()==='Work loose'`);
  await click(null,await item('Work older'));check((await invoke('bootstrap')).view.route.sessionId,'Navigation not persisted');await shot('05-list-navigation');await click(null,'.organized-session.selected [aria-label="Pin chat"]');await wait(`!!document.querySelector('section[aria-label="Pinned"] .session-row')`);await shot('05b-pinned-selected');await click(null,'section[aria-label="Pinned"] [aria-label="Unpin chat"]');await wait(`!document.querySelector('section[aria-label="Pinned"]')`);
  await click(null,'#activity');await wait(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);
  await options('Chat');await choice('Priority');await wait(`document.querySelector('.session-row').textContent.trim()==='Work older'`);
  await click(null,'#running');await click(null,'#attention');await wait(`document.querySelector('.session-row').textContent.trim()==='Home older'`);await shot('05c-waiting-unread-running-priority');
  await click(null,'#clear-attention');await wait(`document.querySelector('.session-row').textContent.trim()==='Work older'`);
  await click(null,await item('Work older'));await click(null,'#load-transcript');await wait(`(()=>{const s=JSON.parse(document.querySelector('#transcript-sequence').textContent);return s.read!==null&&s.read<s.current&&s.pending>0})()`);check(await run(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`),'Old getMessages settlement cleared newer activity');await shot('05d-old-transcript-keeps-new-activity');await click(null,'#hide-transcript');await click(null,'#load-transcript');await wait(`(()=>{const s=JSON.parse(document.querySelector('#transcript-sequence').textContent);return s.read===s.current})()`);
  await new Promise(r=>setTimeout(r,160));check(await run(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`),'Hidden transcript cleared unread');
  await click(null,'#hide-transcript');await wait(`!document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);await shot('05d-loaded-foreground-read');
  await click(null,await item('Work older'),true);await click('Mark as unread');await wait(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);
  await reopen();await wait(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);await shot('05e-read-mark-reopened');
  await click(null,'#offline');const beforeRead=(await invoke('evidence')).calls.length;
  await click(null,await item('Work older'),true);await click('Mark as read');await wait(`!document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);
  const readEvidence=await invoke('evidence'),readCalls=readEvidence.calls.slice(beforeRead);check(readCalls.length===1&&readCalls[0].host===readEvidence.persisted[0].state.host.id&&readCalls[0].command==='preferences.put','Remote offline mark did not use local replica');
  await click(null,'#offline');await click(null,'#activity');await wait(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);await shot('05f-new-activity-after-mark');
  await click(null,'#remote-read');await wait(`!document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);
  await click(null,'#remote-unread');await wait(`document.querySelector(${JSON.stringify(await item('Work older'))}).closest('.organized-session').classList.contains('unread')`);await shot('05g-other-device-read-mark-delivery');
  await options('Chat');await choice('Manual order');await click(null,await item('Work older'),true);await click('Move down');
  await wait(`(()=>{const s=JSON.parse(document.querySelector('#preference-status').textContent);return !s.busy&&!s.pending})()`);const manualOrder=await run(`[...document.querySelectorAll('.session-row')].map(n=>n.dataset.hostId+':'+n.dataset.sessionId)`);
  await click(null,'#activity');check(JSON.stringify(await run(`[...document.querySelectorAll('.session-row')].map(n=>n.dataset.hostId+':'+n.dataset.sessionId)`))===JSON.stringify(manualOrder),'Manual order changed on native activity');
  await reopen();check(JSON.stringify(await run(`[...document.querySelectorAll('.session-row')].map(n=>n.dataset.hostId+':'+n.dataset.sessionId)`))===JSON.stringify(manualOrder),'Manual chat order not retained');await shot('05h-manual-chats-reopened');
  await newSection('Focus');await moveToSection('Home older');await moveToSection('Work older');await wait(`document.querySelectorAll('section[aria-label="Focus"] .session-row').length===2`);
  await archiveOpen();await click('Cancel');check((await invoke('evidence')).calls.filter(x=>x.command==='session.archive').length===0,'Cancel archived');
  await click(null,'#fail-archive');await archiveOpen();await archiveFinish();await wait(has('could not be archived'));await shot('06-partial-archive-refusal');
  await click('Retry failed chats');await wait(`!document.querySelector('dialog[open]')`);let evidence=await invoke('evidence');check(evidence.persisted.flatMap(x=>x.state.sessions).filter(x=>x.archived).length===2,'Archive retry did not persist both owners');
  await click(null,'[aria-label="Show archived chats"]');await wait(`document.querySelectorAll('section[aria-label="Focus"] .session-row').length===2`);let workSelector=await item('Work older');await run(`document.querySelector(${JSON.stringify(workSelector)}).scrollIntoView()`);await click(null,workSelector);await click(null,`section[aria-label="Focus"] .organized-session.selected [aria-label="Unarchive chat"]`);await wait(`document.querySelectorAll('section[aria-label="Focus"] .session-row').length===1`);await shot('07-archived-reopen');
  await click(null,'[aria-label="Show active chats"]');await moveToSection('Home newer');await moveToSection('Work newer');await click(null,'#offline');const before=(await invoke('evidence')).calls.filter(x=>x.command==='session.archive').length;
  await archiveOpen();await archiveFinish();await wait(has('could not be archived'));evidence=await invoke('evidence');check(evidence.calls.filter(x=>x.command==='session.archive').length===before+1,'Offline owner was dispatched');await shot('08-offline-partial');
  await click('Cancel');await click(null,'#offline');await archiveOpen();await archiveFinish();await wait(`!document.querySelector('dialog[open]')`);
  await newSection('Later');await click(null,'[aria-label="Options for Later"]');await click('Move up');await wait(`document.querySelector('.custom-sidebar-section')?.getAttribute('aria-label')==='Later'`);await click('Later');await reopen();await wait(`document.querySelector('.custom-sidebar-section')?.getAttribute('aria-label')==='Later'`);check(await run(`document.querySelector('section[aria-label="Later"] .sidebar-section-toggle').getAttribute('aria-expanded')==='false'`),'Section disclosure not restored');await shot('09-sections-reordered-restored');
  await options('Chat');await key('ArrowDown');await key('ArrowUp');await key('Escape');check(await run(`document.activeElement.getAttribute('aria-label')==='Chat sidebar options'`),'Escape lost trigger focus');await shot('10-keyboard-menu-close');
  check(errors.length===0,'Renderer errors: '+errors.join('\n'));exit=0;
 } catch(cause){errors.push(String(cause));console.error(cause);if(win){fs.writeFileSync(path.join(out,'failure.txt'),await win.webContents.executeJavaScript('document.body.innerText'));fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());}}
 finally {let evidence;try{evidence=await invoke('evidence')}catch{}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({exit,checkpoints,errors,evidence},null,2));win?.destroy();app.exit(exit)}
});
