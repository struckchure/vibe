/** Community WebSocket BitTorrent trackers (SPEC §9.5 style). */
export const COMMUNITY_TRACKER_URLS: string[] = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.files.fm:7073/announce",
];

export function resolveTrackerUrls(): string[] {
  return [...COMMUNITY_TRACKER_URLS];
}
