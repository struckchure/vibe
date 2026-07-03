/** Community WebSocket BitTorrent trackers (SPEC §9.5 style). */
export const COMMUNITY_TRACKER_URLS: string[] = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
];

export function resolveTrackerUrls(): string[] {
  return [...COMMUNITY_TRACKER_URLS];
}
