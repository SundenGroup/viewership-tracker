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
  /**
   * True when the adapter could not fetch this channel at all (timeout,
   * throttling, error page) as opposed to confirming it offline. The
   * orchestrator writes no row for it: a failed fetch is unknown, not zero.
   */
  fetchFailed?: boolean;
  /**
   * True when the adapter positively confirmed this stream belongs to the
   * channel it is reported under (videos.list owner, or the channel-scoped
   * API path). Multi-stream child rows are only ever created from these.
   */
  ownerVerified?: boolean;
  /**
   * The platform's public view counter for this stream at poll time
   * (YouTube `statistics.viewCount`). Lags behind the audience while live;
   * only used for the share of views inside a broadcast window.
   */
  platformViews?: number;
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
  /** Platform category code the stream is listed under (SOOP: broad_cate_no). */
  platformCategoryId?: string | null;
}

export interface PlatformAdapter {
  readonly platform: string;

  getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]>;

  searchLiveStreams(
    gameId?: string,
    keywords?: string[],
    platformCategoryIds?: string[],
    /** Partner string from tournament_series.partner — only consulted by
     *  the YouTube adapter for partner-tagged API key routing. Other
     *  adapters ignore this. */
    partner?: string | null,
    /** Per-series knobs; only the YouTube adapter reads them today. */
    options?: SearchOptions,
  ): Promise<DiscoveredStream[]>;
}

export interface SearchOptions {
  /**
   * How many result pages (50 hits, 100 quota units each) one keyword may
   * fetch on YouTube. Each project allows 100 searches a day, so this is
   * the series' main cost lever: the watch parties sit on the first page.
   */
  youtubeSearchPages?: number;
}
