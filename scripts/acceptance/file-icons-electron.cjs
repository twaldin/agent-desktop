const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');const output=process.argv[2];app.setPath('userData',path.join(output,'profile'));
const fixture=JSON.parse(fs.readFileSync(path.join(output,'fixture.json'),'utf8'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:fixture.height,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')console.error(details.message)});
 const js=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){throw Error(`${s}: ${e}`)}},pause=ms=>new Promise(r=>setTimeout(r,ms)),observations=[],network=[];
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{if(!/^(file|data|devtools):/.test(d.url))network.push(d.url);cb({cancel:/^https?:/.test(d.url)});});
 try{win.webContents.debugger.attach('1.3');await win.loadFile(path.join(output,'web/index.html'));
  for(const theme of ['dark','light']){
   await js(`window.theme(${JSON.stringify(theme)})`);await pause(200);
   const baseline=await js('window.baseline()'),cases=await js('window.cases()');if(cases.length!==fixture.count)throw Error('Incomplete glyph inventory');
   const results=[];
   for(const row of cases){
    if(fixture.family==='tree'&&row.color!==row.referenceColor)throw Error(`Native palette mismatch ${row.id}: ${row.color} / ${row.referenceColor}`);
    for(const rect of [row.candidate,row.reference])if(!Object.values(rect).every(Number.isInteger))throw Error('Fractional registration');
    const a=await win.webContents.capturePage(row.candidate);
    await js(`window.alignReference(${JSON.stringify(row.id)})`);await pause(20);
    const b=await win.webContents.capturePage(row.candidate);await js(`window.restoreReference(${JSON.stringify(row.id)})`);await pause(20);
    const ab=a.toBitmap(),bb=b.toBitmap();
    if(ab.length!==bb.length)throw Error('Raster mismatch');let delta=0,max=0;for(let i=0;i<ab.length;i++)if(ab[i]!==bb[i]){delta++;max=Math.max(max,Math.abs(ab[i]-bb[i]));}
    results.push({id:row.id,differingChannels:delta,maxChannelDelta:max,raster:a.getSize(),rects:row,comparison:'same-parent sequential capture, reference SVG temporarily replaces candidate SVG after canonical attribute equality'});
   }
   const frame=await win.webContents.capturePage();fs.writeFileSync(path.join(output,theme+'.png'),frame.toPNG());fs.writeFileSync(path.join(output,theme+'.ax.json'),JSON.stringify(await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree'),null,2));observations.push({theme,baseline,results,zoom:win.webContents.getZoomFactor(),raster:frame.getSize()});
  }
  const themeOverride=fixture.family==='tree'?await js('window.themeOverride()'):null;
  if(themeOverride&&(themeOverride.typescript!=='rgb(18, 52, 86)'||themeOverride.react!=='rgb(171, 205, 239)'))throw Error('Tree theme override did not propagate');
  const passed=network.length===0&&observations.every(o=>o.baseline.errors.length===0&&o.results.every(r=>r.differingChannels===0));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed,observations,themeOverride,network,scope:'Static extracted-vector comparison in the same Electron renderer, not native window or whole-app parity.'},null,2));app.exit(passed?0:1);
 }catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:String(error),observations,network},null,2));app.exit(1);}
});
