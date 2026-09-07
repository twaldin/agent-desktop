import React from 'react';
import { createRoot } from 'react-dom/client';
import { PendingMcpAuthorization } from '../../apps/desktop/src/renderer/SessionMcpAuthorization';
import { SessionMcp } from '../../apps/desktop/src/renderer/SessionMcp';
import type { DesktopBridge } from '@agent-desktop/shared';
import '../../apps/desktop/src/renderer/styles.css';
import '../../apps/desktop/src/renderer/theme.css';
import '../../apps/desktop/src/renderer/native-integrations.css';
const params = new URLSearchParams(location.search);
const bridge = (window as unknown as {fixture:DesktopBridge}).fixture;
createRoot(document.getElementById('root')!).render(<React.StrictMode><main className="settings-page native-integrations"><div className="integration-content"><Fixture/></div></main></React.StrictMode>);

function Fixture(){const props={bridge,hostId:params.get('hostId')!,sessionId:params.get('sessionId')!,connected:true};return params.get('conversation')==='true'? <div className="composer-region"><PendingMcpAuthorization {...props}/></div>:<SessionMcp {...props} idle/>;}
