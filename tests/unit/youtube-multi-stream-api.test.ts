/**
 * Tests for the API-based multi-stream tracking path.
 *
 * Coverage is intentionally narrow — the full code path (search.list →
 * videos.list → ChannelSnapshot[]) requires DB and axios mocks the rest of
 * this suite doesn't set up. These tests cover the public contract of the
 * setter and the orchestrator-side filter logic that decides which channels
 * are routed through the API path.
 */

describe('multi_stream_via_api filter (orchestrator-side)', () => {
  // Replicate the filter at polling-orchestrator.ts:597-600 so we can test
  // the logic without booting the registry / DB.
  function selectApiChannels(
    channels: Array<{
      platform: string;
      channel_identifier: string;
      metadata: Record<string, unknown> | null | undefined;
    }>,
  ): string[] {
    return channels
      .filter(
        (ch) =>
          ch.platform === 'youtube' &&
          (ch.metadata as Record<string, unknown> | null | undefined)?.multi_stream_via_api ===
            true,
      )
      .map((ch) => ch.channel_identifier);
  }

  test('selects YouTube channels with multi_stream_via_api=true', () => {
    const result = selectApiChannels([
      {
        platform: 'youtube',
        channel_identifier: 'UCabc',
        metadata: { multi_stream: true, multi_stream_via_api: true },
      },
    ]);
    expect(result).toEqual(['UCabc']);
  });

  test('ignores channels without the flag, even if multi_stream is set', () => {
    const result = selectApiChannels([
      {
        platform: 'youtube',
        channel_identifier: 'UC_old',
        metadata: { multi_stream: true },
      },
    ]);
    expect(result).toEqual([]);
  });

  test('ignores non-YouTube platforms even with the flag', () => {
    const result = selectApiChannels([
      {
        platform: 'twitch',
        channel_identifier: 'pubg_battlegrounds',
        metadata: { multi_stream_via_api: true },
      },
    ]);
    expect(result).toEqual([]);
  });

  test('handles missing/null metadata safely', () => {
    const result = selectApiChannels([
      { platform: 'youtube', channel_identifier: 'UCx', metadata: null },
      { platform: 'youtube', channel_identifier: 'UCy', metadata: undefined },
      { platform: 'youtube', channel_identifier: 'UCz', metadata: {} },
    ]);
    expect(result).toEqual([]);
  });

  test('returns multiple channels when several are flagged', () => {
    const result = selectApiChannels([
      { platform: 'youtube', channel_identifier: 'UCa', metadata: { multi_stream_via_api: true } },
      { platform: 'youtube', channel_identifier: 'UCb', metadata: {} },
      { platform: 'youtube', channel_identifier: 'UCc', metadata: { multi_stream_via_api: true } },
    ]);
    expect(result).toEqual(['UCa', 'UCc']);
  });
});

describe('YouTubeAdapter.setMultiStreamApiChannels', () => {
  // Skip if env doesn't allow constructing the adapter (e.g. config validation).
  // We just test the setter's storage contract via reflection-like access.

  test('lowercases identifiers for case-insensitive matching', () => {
    process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? 'test-key';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://test:test@localhost/test';

    const { YouTubeAdapter } = require('../../src/adapters/youtube');
    const adapter = new YouTubeAdapter('test-key');

    adapter.setMultiStreamApiChannels(['UCabcDEF', 'PUBGEsports']);

    // The Set is private; we access it via the boolean check inside the
    // adapter's own logic. Use reflection to read the field for testing.
    const stored: Set<string> = (adapter as unknown as { multiStreamApiChannels: Set<string> })
      .multiStreamApiChannels;
    expect(stored.has('ucabcdef')).toBe(true);
    expect(stored.has('pubgesports')).toBe(true);
    expect(stored.size).toBe(2);
  });

  test('replaces (not appends) on subsequent calls', () => {
    process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? 'test-key';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://test:test@localhost/test';

    const { YouTubeAdapter } = require('../../src/adapters/youtube');
    const adapter = new YouTubeAdapter('test-key');

    adapter.setMultiStreamApiChannels(['UCfirst']);
    adapter.setMultiStreamApiChannels(['UCsecond']);

    const stored: Set<string> = (adapter as unknown as { multiStreamApiChannels: Set<string> })
      .multiStreamApiChannels;
    expect(stored.has('ucfirst')).toBe(false);
    expect(stored.has('ucsecond')).toBe(true);
    expect(stored.size).toBe(1);
  });

  test('empty array clears the flag set', () => {
    process.env.YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? 'test-key';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://test:test@localhost/test';

    const { YouTubeAdapter } = require('../../src/adapters/youtube');
    const adapter = new YouTubeAdapter('test-key');

    adapter.setMultiStreamApiChannels(['UCabc']);
    adapter.setMultiStreamApiChannels([]);

    const stored: Set<string> = (adapter as unknown as { multiStreamApiChannels: Set<string> })
      .multiStreamApiChannels;
    expect(stored.size).toBe(0);
  });
});
