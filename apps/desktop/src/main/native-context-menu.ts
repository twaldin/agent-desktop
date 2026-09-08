import {Menu,type BrowserWindow,type MenuItemConstructorOptions} from 'electron';
import {parseDesktopMenu,type DesktopMenuItem} from '../../../../packages/shared/src/context-menu';
export function contextMenuTemplate(items:DesktopMenuItem[],choose:(id:string)=>void):MenuItemConstructorOptions[]{
 return items.map(item=>'type'in item?{type:'separator'}:{id:item.id,label:item.label,enabled:item.enabled??true,...(item.submenu?{submenu:contextMenuTemplate(item.submenu,choose)}:{click:()=>choose(item.id)})});
}
const openMenus=new Map<number,Menu>();
export async function showDesktopContextMenu(window:BrowserWindow,input:unknown):Promise<string|null>{
 const items=parseDesktopMenu(input);if(window.isDestroyed())return null;
 openMenus.get(window.id)?.closePopup(window);
 return new Promise((resolve,reject)=>{
  let choice:string|null=null,settled=false;
  const menu=Menu.buildFromTemplate(contextMenuTemplate(items,id=>{choice=id}));
  const finish=(error?:unknown)=>{if(settled)return;settled=true;window.removeListener('closed',closed);if(openMenus.get(window.id)===menu)openMenus.delete(window.id);if(error)reject(error);else resolve(choice)};
  const closed=()=>{menu.closePopup();finish()};window.once('closed',closed);openMenus.set(window.id,menu);
  try{menu.popup({window,callback:()=>finish()})}catch(error){finish(error)}
 });
}
