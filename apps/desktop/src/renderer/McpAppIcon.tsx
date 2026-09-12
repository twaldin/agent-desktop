/** Provider artwork follows the app's configured theme, independently of macOS. */
export function McpAppIcon({ icon }: { icon: { light: string; dark: string } }) {
  return <span className="mcp-app-icon" aria-hidden="true"><img className="icon mcp-icon-light" src={icon.light} alt="" referrerPolicy="no-referrer"/><img className="icon mcp-icon-dark" src={icon.dark} alt="" referrerPolicy="no-referrer"/></span>;
}
