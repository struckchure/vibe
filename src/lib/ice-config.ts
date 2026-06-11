/** Community catalog STUN/TURN — mirrors bootstrap.rs / SPEC §9.5.3. */
export const COMMUNITY_CATALOG_ICE: RTCIceServer[] = [
  { urls: "stun:stun.relay.metered.ca:80" },
  {
    urls: [
      "turn:global.relay.metered.ca:80",
      "turn:global.relay.metered.ca:80?transport=tcp",
      "turn:global.relay.metered.ca:443",
      "turns:global.relay.metered.ca:443?transport=tcp",
    ],
    username: "7521f662b14a5659afe71746",
    credential: "wWGZQ+CdZ6c7pjKf",
  },
];

export function resolveIceServers(): Promise<RTCIceServer[]> {
  return Promise.resolve(COMMUNITY_CATALOG_ICE);
}
