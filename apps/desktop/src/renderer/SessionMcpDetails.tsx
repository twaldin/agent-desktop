import type { NativeSessionMcpServer } from "@agent-desktop/shared";
import { Icon } from "./Icons";

export function SessionMcpDetails({ server, onReadResource }: { server: NativeSessionMcpServer; onReadResource?(uri:string):void }) {
  return <div className="session-mcp-details">
    <details><summary><Icon name="chevron"/>Resources</summary>
      {server.resources == null ? <p className="integration-note">Resource details have not been measured.</p> :
        <ul>{server.resources.map((resource, index) => <li key={`${resource.uri}:${index}`}><strong>{resource.name}</strong><code>{resource.uri}</code>{onReadResource && <button className="secondary-button" type="button" onClick={event=>{event.currentTarget.focus();onReadResource(resource.uri);}}>Open resource</button>}{resource.description && <p>{resource.description}</p>}{resource.mimeType && <small>{resource.mimeType}</small>}</li>)}</ul>}
      {server.resourceTemplates == null ? <p className="integration-note">Resource templates have not been measured.</p> : server.resourceTemplates.length > 0 && <>
        <h3>Templates</h3><ul>{server.resourceTemplates.map((template, index) => <li key={`${template.uriTemplate}:${index}`}><strong>{template.name}</strong><code>{template.uriTemplate}</code>{onReadResource && <button className="secondary-button" type="button" onClick={event=>{event.currentTarget.focus();onReadResource(template.uriTemplate);}}>Open template</button>}{template.description && <p>{template.description}</p>}{template.mimeType && <small>{template.mimeType}</small>}</li>)}</ul>
      </>}
      {server.resources?.length === 0 && server.resourceTemplates?.length === 0 && <p className="integration-note">No resources or templates available.</p>}
    </details>
    <details><summary><Icon name="chevron"/>Prompts</summary>
      {server.prompts == null ? <p className="integration-note">Prompt details have not been measured.</p> : server.prompts.length === 0 ? <p className="integration-note">No prompts available.</p> :
        <ul>{server.prompts.map((prompt, index) => <li key={`${prompt.name}:${index}`}><strong>{prompt.name}</strong><code>/{server.name}:{prompt.name}</code>{prompt.description && <p>{prompt.description}</p>}
          {prompt.arguments && prompt.arguments.length > 0 && <dl>{prompt.arguments.map((argument, index) => <div key={`${argument.name}:${index}`}><dt>{argument.name}{argument.required && <span> · Required</span>}</dt>{argument.description && <dd>{argument.description}</dd>}</div>)}</dl>}
        </li>)}</ul>}
    </details>
    <details><summary><Icon name="chevron"/>Notifications</summary>
      {!server.notifications ? <p className="integration-note">Notification state has not been measured.</p> : <>
        <p className="integration-note">{server.notifications.enabled ? "Enabled" : "Disabled"} in native settings</p>
        <ul>{server.notifications.toolsListChanged && <li>Tool list changes</li>}{server.notifications.resourcesListChanged && <li>Resource list changes</li>}{server.notifications.promptsListChanged && <li>Prompt list changes</li>}{server.notifications.resourceSubscribe && <li>Resource subscriptions</li>}</ul>
        {!server.notifications.toolsListChanged && !server.notifications.resourcesListChanged && !server.notifications.promptsListChanged && !server.notifications.resourceSubscribe && <p className="integration-note">No notification capabilities advertised.</p>}
        {server.notifications.resourceSubscribe && (server.notifications.subscriptions.length > 0 ? <><h3>Active subscriptions</h3><ul>{server.notifications.subscriptions.map((uri, index) => <li key={`${uri}:${index}`}><code>{uri}</code></li>)}</ul></> : <p className="integration-note">No active subscriptions.</p>)}
      </>}
    </details>
  </div>;
}

export function matchesMcpServer(server: NativeSessionMcpServer, query: string): boolean {
  const text = [server.name, ...server.tools,
    ...(server.resources ?? []).flatMap(resource => [resource.name, resource.uri, resource.description ?? ""]),
    ...(server.resourceTemplates ?? []).flatMap(template => [template.name, template.uriTemplate, template.description ?? ""]),
    ...(server.prompts ?? []).flatMap(prompt => [prompt.name, prompt.description ?? "", ...(prompt.arguments ?? []).map(arg => arg.name)]),
  ].join(" ");
  return text.toLowerCase().includes(query.toLowerCase());
}
