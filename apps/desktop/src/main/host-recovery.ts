import { requestHost, type HostEndpoint } from "./host-transport";

/** A discovery timeout is not permission to reroute an owner. Revalidate the
 * actual prior endpoint and identity before admitting requests through it. */
export async function verifyKnownHost(endpoint: HostEndpoint): Promise<HostEndpoint> {
  const value = await requestHost(endpoint, "/v1/health") as { protocolVersion?: number; hostId?: string; host?: { id?: string } } | null;
  if (!value || value.protocolVersion !== 1 || value.hostId !== endpoint.hostId || value.host?.id !== endpoint.hostId) {
    throw new Error("The previously connected machine returned a different host identity or incompatible protocol.");
  }
  return endpoint;
}
