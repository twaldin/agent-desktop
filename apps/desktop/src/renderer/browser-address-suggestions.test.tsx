import { expect, test } from "bun:test";
import React from "react";
import { BrowserAddressInput, type BrowserAddressInputProps, type BrowserAddressSuggestion } from "./BrowserAddressInput";
import { BrowserNewTabPanel } from "./BrowserNewTabPanel";
import type { BrowserNewTabController } from "./browser-new-tab";
import { addressSuggestionPosition, addressSuggestionSelection, moveAddressSuggestion } from "./browser-address-suggestion-state";

const SelectedField: typeof BrowserAddressInput = process.env.AGENT_DESKTOP_ADDRESS_ENTER_COMPONENT
  ? (await import(process.env.AGENT_DESKTOP_ADDRESS_ENTER_COMPONENT)).BrowserAddressInput : BrowserAddressInput;

const row = (id: string, title = id, canBeDefault = true): BrowserAddressSuggestion => ({ id, title, canBeDefault });

test("empty actions do not steal Enter; ordinary search can default but URLs and private paths cannot", () => {
  const rows = [row("first")];
  for (const value of ["", " ", "localhost:8000", "example.com", "about:blank", "https://www.google.com/search?q=first", "/private/secret"])
    expect(addressSuggestionSelection(value, rows).selected).toBeUndefined();
  expect(addressSuggestionSelection("first", rows).selected?.id).toBe("first");
  expect(addressSuggestionSelection("first", [row("first", "first", false)]).selected).toBeUndefined();
});

test("arrows wrap and freeze identities, dropping missing rows without admitting late arrivals", () => {
  const rows = [row("a"), row("b"), row("c")];
  let selection = moveAddressSuggestion("", rows, -1);
  expect(selection?.selectedId).toBe("c");
  selection = moveAddressSuggestion("", rows, 1, selection);
  expect(selection?.selectedId).toBe("a");
  selection = moveAddressSuggestion("", rows, 1, selection);
  expect(selection?.selectedId).toBe("b");
  const changed = [row("late"), row("c", "renamed"), row("a")];
  const missing = addressSuggestionSelection("", changed, selection);
  expect(missing.rows.map(r => r.id)).toEqual(["a", "c"]);
  expect(missing.missing).toBe(true);
  expect(missing.selected).toBeUndefined();
  selection = moveAddressSuggestion("", changed, -1, selection);
  expect(selection?.selectedId).toBe("c");
  expect(addressSuggestionSelection("", changed, selection).selected?.title).toBe("renamed");
  expect(addressSuggestionSelection("changed", changed, selection).rows.map(r => r.id)).toEqual(["late", "c", "a"]);
});

test("popup positioning preserves below-anchor gap zero and stays within narrow viewports", () => {
  const anchor = {left:1200,right:1410,top:50,bottom:80,width:210};
  expect(addressSuggestionPosition(anchor,{width:1440,height:1000})).toEqual({left:1076,top:80,width:360,maxHeight:916});
  expect(addressSuggestionPosition({left:20,right:330,top:100,bottom:128,width:310},{width:320,height:240}))
    .toEqual({left:4,top:128,width:312,maxHeight:108});
  expect(addressSuggestionPosition({...anchor,bottom:1001},{width:1440,height:1000})).toBeUndefined();
  expect(addressSuggestionPosition({...anchor,left:1500,right:1600},{width:1440,height:1000})).toBeUndefined();
  expect(addressSuggestionPosition({...anchor,width:NaN},{width:1440,height:1000})).toBeUndefined();
});

/** Actual component handlers and layout/passive cleanup with controlled slots,
 * geometry, RAF and event objects. This is not ReactDOM, browser focus or IME proof. */
function field(initial: Partial<BrowserAddressInputProps<BrowserAddressSuggestion>> = {}) {
  const saved = new Map<string,PropertyDescriptor|undefined>();
  const setGlobal=(name:string,value:unknown)=>{saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,value});};
  const frames=new Map<number,FrameRequestCallback>();let nextFrame=0;
  setGlobal("window",new EventTarget());setGlobal("document",{body:{nodeType:1}});setGlobal("innerWidth",1440);setGlobal("innerHeight",1000);
  setGlobal("requestAnimationFrame",(cb:FrameRequestCallback)=>{frames.set(++nextFrame,cb);return nextFrame;});setGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
  const chosen:BrowserAddressSuggestion[]=[], submissions:string[]=[],changes:string[]=[];let cancelled=0,blurred=0;
  let rect={left:300,right:600,top:40,bottom:70,width:300};
  const anchor={isConnected:true,getClientRects:()=>[rect],getBoundingClientRect:()=>rect};
  const inputNode={blur(){blurred++;input().props.onBlur();}};
  let props:BrowserAddressInputProps<BrowserAddressSuggestion>={inputRef:{current:inputNode as HTMLInputElement},anchorRef:{current:anchor as unknown as HTMLElement},owner:'["owner","session"]',value:"",draft:false,disabled:false,readOnly:false,suggestions:[row("a"),row("b")],onChoose:r=>chosen.push(r),onSubmit:()=>submissions.push(props.value),onChange:value=>{changes.push(value);props={...props,value,draft:true};},onCancel:()=>{cancelled++;},...initial};
  const slots:any[]=[],effectQueue:Array<()=>void>=[];let cursor=0,dirty=false,tree:any;
  const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const effect=(run:()=>void|(()=>void),deps:unknown[])=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))effectQueue.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:run()};});};
  const dispatcher={useId(){const i=cursor++;return slots[i]??(slots[i]=`field-${i}`);},useRef(value:unknown){const i=cursor++;return slots[i]??(slots[i]={current:value});},useState(value:any){const i=cursor++;if(!(i in slots))slots[i]=typeof value==="function"?value():value;return[slots[i],(next:any)=>{const v=typeof next==="function"?next(slots[i]):next;if(!Object.is(v,slots[i])){slots[i]=v;dirty=true;}}];},useLayoutEffect:effect,useEffect:effect};
  function render(){let runs=0;do{dirty=false;cursor=0;const previous=internals.H;internals.H=dispatcher;try{tree=SelectedField(props);}finally{internals.H=previous;}while(effectQueue.length)effectQueue.shift()!();if(++runs>20)throw new Error("unstable controlled render");}while(dirty);return tree;}
  function input():any{return render().props.children[0];}
  function popup():any{return render().props.children[1];}
  return {chosen,submissions,changes,frames,input,popup,render,
    get cancelled(){return cancelled;},get blurred(){return blurred;},
    update(p:Partial<typeof props>){props={...props,...p};render();},
    focus(){input().props.onFocus();render();},
    key(key:string,extra:Record<string,unknown>={}){let prevented=0,stopped=0;input().props.onKeyDown({key,nativeEvent:{isComposing:false},currentTarget:inputNode,preventDefault(){prevented++;},stopPropagation(){stopped++;},...extra});render();return{prevented,stopped};},
    tick(next:typeof rect){rect=next;const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb(0));render();},
    close(){slots.forEach(slot=>slot?.cleanup?.());for(const[name,value]of saved){if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}},
  };
}

test("actual field Enter, pointer and Escape handlers keep selection intent separate from URL submission", () => {
  const f=field();try{
    f.focus();expect(f.input().props["aria-expanded"]).toBe(true);
    expect(f.popup().containerInfo).toBe((globalThis.document as any).body);
    expect(f.popup().children.props["aria-label"]).toBe("Address suggestions");
    expect(f.input().props["aria-activedescendant"]).toBeUndefined();
    f.key("Enter");expect(f.submissions).toEqual([""]);expect(f.chosen).toEqual([]);
    f.key("ArrowDown");expect(f.input().props["aria-activedescendant"]).toBe("field-0-option-0");
    f.key("Enter");expect(f.chosen.map(r=>r.id)).toEqual(["a"]);
    expect(f.changes).toEqual([]);expect(f.blurred).toBe(0);
    const button=f.popup().children.props.children[1];let prevented=0;
    button.props.onPointerDown({preventDefault(){prevented++;}});button.props.onClick();
    expect(prevented).toBe(1);expect(button.props.tabIndex).toBe(-1);expect(button.props.role).toBe("option");
    expect(f.chosen.map(r=>r.id)).toEqual(["a","b"]);expect(f.blurred).toBe(0);
    f.key("Escape");expect(f.cancelled).toBe(1);expect(f.blurred).toBe(1);expect(f.input().props["aria-expanded"]).toBe(false);expect(f.frames.size).toBe(0);
  }finally{f.close();}
});

/** Execute the actual parent form callback only if the actual field handler
 * leaves Enter's default unprevented. This models implicit form submission;
 * it is not an executed browser/ReactDOM default-action or native-key test. */
function coupledPanel(value: string) {
  const chosen: string[] = [], submitted: string[] = [];
  const controller = { state: { status: "idle", draft: value }, tab: { hostId: "host", target: "session:session" },
    submit() { submitted.push(value); }, edit() {}, observePresentation() {} } as unknown as BrowserNewTabController;
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = { useRef: (current: unknown) => ({ current }), useEffect() {}, useLayoutEffect() {} };
  let tree: any;
  try { tree = BrowserNewTabPanel({ controller, active: true, suggestions: [row("a"), row("b")], onChoose: r => chosen.push(r.id) }); }
  finally { internals.H = previous; }
  const form = tree.props.children[0].props.children.find((child: any) => child.type === "form");
  const actualField = form.props.children[0];
  const f = field(actualField.props);
  let implicitSubmits = 0;
  return { ...f, chosen, submitted,
    key(key: string, modifiers: Record<string, unknown> = {}) {
      const result = f.key(key, modifiers);
      if ((key === "Enter" || key === "Return") && result.prevented === 0) {
        implicitSubmits++;
        form.props.onSubmit({ preventDefault() {} });
      }
      return result;
    },
    get implicitSubmits() { return implicitSubmits; },
  };
}

for (const submitKey of ["Enter", "Return"]) for (const [name, modifiers] of Object.entries({ plain: {}, alt: { altKey: true }, control: { ctrlKey: true },
  command: { metaKey: true }, shift: { shiftKey: true }, combined: { altKey: true, ctrlKey: true, metaKey: true, shiftKey: true } })) {
  test(`parent form cannot bypass missing selection on ${name} ${submitKey}`, () => {
    const f = coupledPanel("original draft");
    try {
      f.focus(); f.key("ArrowDown");
      f.update({ suggestions: [row("late"), row("a")] });
      f.key(submitKey, modifiers);
      expect(f.submitted).toEqual([]); expect(f.chosen).toEqual([]);
      expect(f.implicitSubmits).toBe(0);
      expect(f.input().props.value).toBe("original draft");
    } finally { f.close(); }
  });
  test(`parent form keeps selection and ordinary URL paths single on ${name} ${submitKey}`, () => {
    const selected = coupledPanel("Terminal");
    try {
      selected.focus(); selected.key(submitKey, modifiers);
      expect(selected.chosen).toEqual(["a"]); expect(selected.submitted).toEqual([]); expect(selected.implicitSubmits).toBe(0);
    } finally { selected.close(); }
    const url = coupledPanel("https://example.com");
    try {
      url.focus(); url.key(submitKey, modifiers);
      expect(url.chosen).toEqual([]); expect(url.submitted).toEqual(["https://example.com"]); expect(url.implicitSubmits).toBe(0);
    } finally { url.close(); }
  });
}

test("parent form Enter keeps composition and disabled/read-only submission guards", () => {
  for (const submitKey of ["Enter", "Return"]) for (const mode of ["composition", "native-composition", "key229", "disabled", "readOnly"] as const) {
    const f = coupledPanel("https://example.com");
    try {
      f.focus();
      if (mode === "composition") { f.input().props.onCompositionStart(); f.render(); }
      if (mode === "disabled") f.update({ disabled: true });
      if (mode === "readOnly") f.update({ readOnly: true });
      f.key(submitKey, { metaKey: true, ...(mode === "native-composition" ? { nativeEvent: { isComposing: true } } : {}), ...(mode === "key229" ? { keyCode: 229 } : {}) });
      expect(f.submitted).toEqual([]); expect(f.chosen).toEqual([]); expect(f.implicitSubmits).toBe(0);
    } finally { f.close(); }
  }
});

test("actual field does not submit a vanished selected row and edit resets frozen selection", () => {
  const f=field();try{
    f.focus();f.key("ArrowDown");f.update({suggestions:[row("late"),row("b")]});
    expect(f.popup().children.props.children.map((b:any)=>b.props.children[1].props.children)).toEqual(["b"]);
    f.key("Enter");expect(f.chosen).toEqual([]);expect(f.submissions).toEqual([]);
    f.input().props.onChange({currentTarget:{value:"late"}});f.render();f.key("Enter");
    expect(f.chosen.map(r=>r.id)).toEqual(["late"]);expect(f.changes).toEqual(["late"]);
    f.update({value:"example.com",suggestions:[row("domain","example.com")]});f.key("Enter");
    expect(f.submissions).toEqual(["example.com"]);expect(f.chosen).toHaveLength(1);
  }finally{f.close();}
});

test("actual field composition blocks Enter and arrows, even when native composing flag is missing", () => {
  const f=field({value:"Terminal"});try{
    f.focus();f.input().props.onCompositionStart();f.render();
    expect(f.key("Enter").prevented).toBe(1);f.key("ArrowDown");
    expect(f.input().props["aria-expanded"]).toBe(false);expect(f.chosen).toEqual([]);expect(f.submissions).toEqual([]);
    f.input().props.onCompositionEnd();f.render();
    f.key("Enter",{nativeEvent:{isComposing:true}});f.key("Enter",{keyCode:229});
    expect(f.chosen).toEqual([]);f.key("Enter");expect(f.chosen.map(r=>r.id)).toEqual(["a"]);
  }finally{f.close();}
});

test("actual field portal follows anchor motion, cancels RAF when unavailable, and restores no selection on reactivation", () => {
  const f=field();try{
    f.focus();f.key("ArrowDown");expect(f.frames.size).toBe(1);
    f.tick({left:1300,right:1430,top:300,bottom:330,width:130});
    expect(f.popup().children.props.style).toEqual({left:1076,top:330,width:360,maxHeight:666});
    f.update({disabled:true});expect(f.input().props["aria-expanded"]).toBe(false);expect(f.frames.size).toBe(0);
    f.update({disabled:false});expect(f.input().props["aria-expanded"]).toBe(false);
    f.focus();expect(f.input().props["aria-activedescendant"]).toBeUndefined();
    window.dispatchEvent(new Event("blur"));f.render();expect(f.frames.size).toBe(0);
    f.input().props.onPointerDown();f.render();expect(f.input().props["aria-expanded"]).toBe(true);
    f.update({readOnly:true});expect(f.input().props["aria-expanded"]).toBe(false);expect(f.frames.size).toBe(0);
  }finally{f.close();}
});

test("existing launcher with no supplied selection owner retains ordinary address-only behavior", () => {
  const f=field({onChoose:undefined,value:"Terminal"});try{
    f.focus();expect(f.input().props["aria-expanded"]).toBe(false);expect(f.input().props["aria-autocomplete"]).toBe("none");
    f.key("Enter");expect(f.submissions).toEqual(["Terminal"]);expect(f.chosen).toEqual([]);expect(f.frames.size).toBe(0);
  }finally{f.close();}
});
