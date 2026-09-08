import {createElement} from "react";
import {createRoot} from "react-dom/client";
import {TreeFileIcon} from "../../apps/desktop/src/renderer/TreeFileIcon";
import {type TreeIconToken} from "../../apps/desktop/src/renderer/tree-file-icon-token";
import {parseThemeDocument,DEFAULT_THEME} from "../../packages/shared/src/theme";
import {FileTypeIcon} from "../../apps/desktop/src/renderer/FileTypeIcon";
import {fileIconKind,type FileIconKind} from "../../apps/desktop/src/renderer/file-icon-kind";
import {DockPanel} from "../../apps/desktop/src/renderer/DockPanel";
import {createDockState,insertDockTab,type DockTab} from "../../apps/desktop/src/renderer/dock-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";
declare const __FILE_ICON_REFERENCE__: {family?:"tree";icons:Record<string,{svg:Vector}>};
interface Vector {tag:string;attrs:Record<string,string|number>;children:Vector[]}
const tree=__FILE_ICON_REFERENCE__.family==="tree";
const icons=Object.entries(__FILE_ICON_REFERENCE__.icons);
function reference(node:Vector,key:string):ReturnType<typeof createElement> {
 const attrs={...node.attrs};
 if(typeof attrs.id==="string")attrs.id=`ref-${key}-${attrs.id}`;
 for(const [name,value]of Object.entries(attrs))if(typeof value==="string"&&value.startsWith("url(#"))attrs[name]=`url(#ref-${key}-${value.slice(5)}`;
 return createElement(node.tag,{...attrs,key:node.attrs.id??node.tag},...node.children.map(child=>reference(child,key)));
}
const paths=["src/index.ts","src/view.tsx","README.md","SKILL.md","package.json","unknown.xyz"];
const tabs:DockTab[]=paths.map((filePath,i)=>({id:`fixture-${i}`,title:filePath.split('/').at(-1)!,kind:"file",filePath,hostId:"fixture",target:"project:fixture",...(i===0?{preview:true}: {})}));
let state=createDockState();for(const tab of tabs)state=insertDockTab(state,tab,"right");
const errors:string[]=[];window.addEventListener('error',event=>errors.push(String(event.error??event.message)));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
createRoot(document.getElementById("root")!).render(<main>
 <DockPanel destination="right" state={state} tabs={tabs} viewport={{width:1100,height:900}} onChange={()=>{}} renderTab={()=>null}/>
 <p>Static glyph comparison: production / extracted reference. Controlled labels and layout.</p>
 {([16,24] as const).map(size=><section key={size} className="glyph-grid">{icons.map(([kind,item])=><div key={kind} className="glyph-cell"><span>{kind} {size}px</span><div className="glyph-pair" style={{height:size}}><span className="candidate" data-case={`${kind}-${size}`} style={{width:size,height:size}}><>{tree?<TreeFileIcon path="fixture" token={kind as TreeIconToken} folder={kind.startsWith("chevron-")} expanded={kind==="chevron-open"}/>:<FileTypeIcon kind={kind as FileIconKind}/>}</></span><span className="reference" data-case={`${kind}-${size}`} style={{width:size,height:size}}>{reference(item.svg,`${kind}-${size}`)}</span></div></div>)}</section>)}
 </main>);
const originalGlyphs=new Map<string,Element>();
function canonical(svg:Element){
 const ids=new Map([...svg.querySelectorAll('[id]')].map((node,index)=>[node.id,`local-${index}`]));
 const walk=(node:Element):unknown=>({tag:node.tagName,attrs:Object.fromEntries([...node.attributes].filter(a=>!['class','aria-hidden','focusable','data-file-icon','data-icon-token','data-expanded'].includes(a.name)).map(a=>{let value=a.value;for(const [id,local]of ids){if(a.name==='id'&&value===id)value=local;value=value.replace(`url(#${id})`,`url(#${local})`);}return[a.name,value];}).sort(([a],[b])=>a!.localeCompare(b!))),children:[...node.children].map(walk)});
 return walk(svg);
}
Object.assign(window,{fileIconKind,themeOverride(){
 const tokens={"--trees-icon-blue":"#123456","--trees-file-icon-color-react":"#abcdef"};
 const documentTheme=parseThemeDocument({...DEFAULT_THEME,tokens});for(const [key,value]of Object.entries(documentTheme.tokens))document.documentElement.style.setProperty(key,value);
 const color=(kind:string)=>getComputedStyle(document.querySelector(`.candidate[data-case="${kind}-16"] svg`)!).color;
 const result={typescript:color('typescript'),react:color('react')};for(const key of Object.keys(tokens))document.documentElement.style.removeProperty(key);return result;
},alignReference(id:string){
 const candidate=document.querySelector<HTMLElement>(`.candidate[data-case="${id}"]`)!,ref=document.querySelector<HTMLElement>(`.reference[data-case="${id}"]`)!;
 if(JSON.stringify(canonical(candidate.firstElementChild!))!==JSON.stringify(canonical(ref.firstElementChild!)))throw Error(`Vector attributes differ: ${id}`);
 originalGlyphs.set(id,candidate.firstElementChild!); const copy=ref.firstElementChild!.cloneNode(true) as Element;copy.setAttribute('class',candidate.firstElementChild!.getAttribute('class')??'');for(const attr of ['data-icon-token','data-expanded']){const value=candidate.firstElementChild!.getAttribute(attr);if(value!==null)copy.setAttribute(attr,value);}candidate.replaceChildren(copy);
},restoreReference(id:string){document.querySelector<HTMLElement>(`.candidate[data-case="${id}"]`)!.replaceChildren(originalGlyphs.get(id)!);originalGlyphs.delete(id);},baseline(){return{viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,color:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor,errors};},cases(){return [...document.querySelectorAll<HTMLElement>('.candidate')].map(node=>{const reference=document.querySelector<HTMLElement>(`.reference[data-case="${node.dataset.case}"]`)!;const box=(element:HTMLElement)=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return{id:node.dataset.case,referenceColor:getComputedStyle(reference.firstElementChild!).color,color:getComputedStyle(node.firstElementChild!).color,candidate:box(node),reference:box(reference)};});},theme(theme:string){document.documentElement.dataset.theme=theme;document.body.style.color=theme==='dark'?'rgb(215,215,215)':'rgb(34,34,34)';document.body.style.backgroundColor=theme==='dark'?'rgb(24,24,24)':'rgb(252,252,252)';}});
