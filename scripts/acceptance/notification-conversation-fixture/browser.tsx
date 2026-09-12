import { createRoot } from "react-dom/client";
import { App } from "../../../apps/desktop/src/renderer/App";
import type { DesktopBridge, DesktopEvent, NotificationNavigationRequest } from "@agent-desktop/shared";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";

declare global { interface Window { notificationFixture: { call(method:string,args?:unknown[]):Promise<any>; windowInitial:import("../../../apps/desktop/src/window-state").WindowStateBootstrap; saveWindow(value:unknown):{error?:string}; subscribe(channel:"event"|"navigate",listener:(value:any)=>void):()=>void } } }
const api=window.notificationFixture;
window.agentDesktopWindow={initial:api.windowInitial,save:value=>api.saveWindow(value)};
const bridge:Partial<DesktopBridge>={
  subscribe:listener=>api.subscribe("event",listener as (value:DesktopEvent)=>void),
  subscribeNotificationNavigation:listener=>api.subscribe("navigate",listener as (value:NotificationNavigationRequest)=>void),
  acknowledgeNotificationNavigation:id=>{void api.call("ack",[id]);},
  getState:host=>api.call("getState",[host]),getHosts:()=>api.call("getHosts"),getPreferences:()=>api.call("getPreferences"),
  getTheme:()=>api.call("getTheme"),getLocalFonts:async()=>[],getThemeBackground:async()=>null,applyWindowTheme:async()=>{},
  getMessages:(id,host)=>api.call("getMessages",[id,host]),getInteractions:(id,host)=>api.call("getInteractions",[id,host]),
  getComposerCatalog:(target,refresh,host)=>api.call("getComposerCatalog",[target,refresh,host]),
  getSessionControls:(id,host)=>api.call("getSessionControls",[id,host]),workspaceQuery:(target,query,host)=>api.call("workspaceQuery",[target,query,host]),
  command:(envelope,host)=>api.call("command",[envelope,host]),
};
window.agentDesktop=bridge as DesktopBridge;
createRoot(document.getElementById("root")!).render(<App/>);
Object.assign(window,{notificationFixtureState:()=>({body:document.body.innerText,route:(window.agentDesktopWindow.initial as any)?.state?.route,selected:[...document.querySelectorAll<HTMLElement>("[data-session-id]")].find(node=>node.closest(".selected"))?.dataset.sessionId,unread:[...document.querySelectorAll<HTMLElement>(".organized-session.unread [data-session-id]")].map(node=>node.dataset.sessionId),alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent)})});
