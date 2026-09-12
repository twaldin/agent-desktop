/** Native OMP remote-tool targets. These are not desktop session transports. */
export interface NativeSshHost {
  id: string;
  name: string;
  scope: "user" | "project";
  source: string;
  shadowed: boolean;
  editable: boolean;
}
export interface NativeSshCatalog {
  revision: string;
  hosts: NativeSshHost[];
  warnings: string[];
}
export interface NativeSshDetailRequest { hostId: string; expectedRevision: string }
/** Original unexpanded configuration, never the contents of an identity file. */
export interface NativeSshDetail {
  revision: string;
  host: NativeSshHost;
  config: Record<string, unknown>;
}
export type NativeSshMutation = { expectedRevision: string } & (
  | { operation: "add"; scope: "user" | "project"; name: string; config: Record<string, unknown> }
  | { operation: "update"; hostId: string; config: Record<string, unknown> }
  | { operation: "remove"; hostId: string }
);
