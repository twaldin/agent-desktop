export type DesktopMenuItem={id:string;label:string;enabled?:boolean;submenu?:DesktopMenuItem[]}|{type:"separator"};
/** Descriptors carry display data and IDs only; actions stay with the renderer's owner. */
export function parseDesktopMenu(value:unknown):DesktopMenuItem[]{
 const ids=new Set<string>();let total=0;
 const parse=(items:unknown,depth:number):DesktopMenuItem[]=>{
  if(!Array.isArray(items)||!items.length||items.length>50||depth>2)throw Error("Invalid menu structure");
  return items.map(raw=>{
   if(++total>100||!raw||typeof raw!=="object")throw Error("Invalid menu item");
   const item=raw as Record<string,unknown>;
   if(item.type==='separator'&&Object.keys(item).length===1)return{type:'separator'};
   if(Object.keys(item).some(k=>!['id','label','enabled','submenu'].includes(k))||typeof item.id!=='string'||!item.id||item.id.length>200||ids.has(item.id)||typeof item.label!=='string'||!item.label||item.label.length>500||/[\x00-\x1f\x7f]/.test(item.label)||item.enabled!==undefined&&typeof item.enabled!=='boolean')throw Error('Invalid menu item');
   ids.add(item.id);return{id:item.id,label:item.label,...(item.enabled!==undefined?{enabled:item.enabled as boolean}:{}),...(item.submenu!==undefined?{submenu:parse(item.submenu,depth+1)}:{})};
  });
 };return parse(value,0);
}
