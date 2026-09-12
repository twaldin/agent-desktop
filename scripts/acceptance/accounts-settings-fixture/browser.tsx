import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountsSettings } from '../../../apps/desktop/src/renderer/AccountsSettings';
import '../../../apps/desktop/src/renderer/styles.css';
const unavailable={id:'native-unavailable',name:'Unavailable native provider',source:'builtin',available:false,disabledInSettings:false,loginSupported:true,visibleInNativeLoginList:false,storesCredentialsAs:'oauth',pasteCodeFlow:false,apiKeyStorageSupported:true,transportMayAuthenticateWithoutKey:false,configured:false,storedCredentialCount:0,storedApiKeyConfigured:false,disabledCredentialCount:0,modelCount:0};
const available={...unavailable,id:'fixture-native',name:'Fixture native provider',available:true,visibleInNativeLoginList:true,configured:true};
const fixture=(window as any).fixture;
const bridge={getProviders:async()=>({credentialLocation:{mode:'local'},providers:[available,unavailable],sessionSelectionConnected:true,extensionProviderCoverage:'registered-in-this-process-only'}),getLogins:async()=>[],getAccounts:async(id:string)=>id==='native-unavailable'?[{credentialId:71,providerId:id,type:'oauth',disabled:false,email:'fixture@example.invalid'}]:[],getSessionAccounts:async()=>({sessionId:'session',providerId:'fixture-native',accounts:[]}),accountAction:fixture.action,subscribe:()=>()=>{},openExternal:async()=>{}};
createRoot(document.getElementById('root')!).render(<AccountsSettings bridge={bridge as any} hostId="fixture-host" hostName="Disposable fixture host" localHostId="fixture-host" connected session={{id:'session',title:'Fixture session',model:{provider:'fixture-native'}} as any} onClose={()=>{}} onChanged={()=>{}}/>);
