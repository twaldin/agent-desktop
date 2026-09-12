import {expect,test} from 'bun:test';
import {parseDesktopMenu,type DesktopMenuItem} from '../../../../packages/shared/src/context-menu';
test('native menu IPC accepts display descriptors without executable renderer fields',()=>{
 const menu:DesktopMenuItem[]=[{id:'primary',label:'Open in Editor'}, {id:'with',label:'Open with',submenu:[{id:'target-0',label:'Finder',enabled:false}]},{type:'separator'},{id:'copy',label:'Copy path'}];
 expect(parseDesktopMenu(menu)).toEqual(menu);
 for(const item of [{id:'x',label:'bad',role:'quit'},{id:'x',label:'bad',click:'function(){}'},{id:'x',label:'bad',accelerator:'Cmd+Q'},{id:'x',label:'bad\nitem'},{id:'x',label:'bad',enabled:'yes'}])expect(()=>parseDesktopMenu([item])).toThrow();
});
test('native menus reject duplicate identity, excessive depth and oversized catalogs',()=>{
 expect(()=>parseDesktopMenu([{id:'a',label:'A',submenu:[{id:'a',label:'Duplicate'}]}])).toThrow();
 expect(()=>parseDesktopMenu([{id:'a',label:'A',submenu:[{id:'b',label:'B',submenu:[{id:'c',label:'C',submenu:[{id:'d',label:'D'}]}]}]}])).toThrow();
 expect(()=>parseDesktopMenu(Array.from({length:51},(_,i)=>({id:String(i),label:'row'})))).toThrow();
 expect(()=>parseDesktopMenu([])).toThrow();
});
test('native checkbox descriptors retain checked state without admitting Electron actions',()=>{
 const checked:DesktopMenuItem={type:'checkbox',id:'bottom',label:'Bottom panel',checked:true,enabled:false};
 expect(parseDesktopMenu([checked,{type:'checkbox',id:'other',label:'Other',checked:false}])).toEqual([checked,{type:'checkbox',id:'other',label:'Other',checked:false}]);
 for(const extra of [{checked:'true'},{checked:undefined},{submenu:[{id:'child',label:'Child'}]},{role:'quit'},{type:'radio'},{click:'execute'},{accelerator:'Cmd+Q'}])expect(()=>parseDesktopMenu([{...checked,...extra}])).toThrow();
 expect(()=>parseDesktopMenu([checked,{id:'bottom',label:'Duplicate'}])).toThrow();
 expect(()=>parseDesktopMenu([{id:'no-type',label:'Checked action',checked:true}])).toThrow();
 expect(parseDesktopMenu(Array.from({length:50},(_,i)=>({type:'checkbox',id:String(i),label:'Checkbox',checked:false})))).toHaveLength(50);
});
