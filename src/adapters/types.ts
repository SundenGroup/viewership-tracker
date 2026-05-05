export interface ChannelSnapshot {
  channelIdentifier: string;
  displayName: string;
  concurrentViewers: number;
  isLive: boolean;
  language: string | null;
  gameName: string | null;
  title: string | null;
  startedAt: string | null;
  streamId?: string;
  streamTitle?: string;
  /** Populated by AdapterRegistry.getViewerCountsMultiPlatform to identify source platform */
  platform?: string;
}

export interface DiscoveredStream {
  channelIdentifier: string;
  displayName: string;
  concurrentViewers: number;
  language: string | null;
  title: string;
  /** Optional fields populated by adapters that have them (Twitch, Kick).
   *  Used by the live game tracker to verify the stream is still tagged
   *  with the target game and to record session-level metadata. */
  gameName?: string | null;
  startedAt?: string | null;
  streamId?: string | null;
}

export interface PlatformAdapter {
  readonly platform: string;

  getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]>;

  searchLiveStreams(
    gameId?: string,
    keywords?: string[],
    categoryIds?: string[],
    /** Partner string from tournament_series.partner — only consulted by
     *  the YouTube adapter for partner-tagged API key routing. Other
     *  adapters ignore this. */
    partner?: string | null,
  ): Promise<DiscoveredStream[]>;
}
