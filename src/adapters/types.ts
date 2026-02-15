export interface ChannelSnapshot {
  channelIdentifier: string;
  displayName: string;
  concurrentViewers: number;
  isLive: boolean;
  language: string | null;
  gameName: string | null;
  title: string | null;
  startedAt: string | null;
}

export interface DiscoveredStream {
  channelIdentifier: string;
  displayName: string;
  concurrentViewers: number;
  language: string | null;
  title: string;
}

export interface PlatformAdapter {
  readonly platform: string;

  getViewerCounts(channelIdentifiers: string[]): Promise<ChannelSnapshot[]>;

  searchLiveStreams(
    gameId?: string,
    keywords?: string[],
  ): Promise<DiscoveredStream[]>;
}
