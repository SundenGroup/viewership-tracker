import { TwitchAdapter } from '../../src/adapters/twitch';

function gqlOk(login: string, viewers: number) {
  return { data: { user: { login, displayName: login, stream: { viewersCount: viewers, title: 't', game: { name: 'GeoGuessr' }, createdAt: '2026-09-05T11:00:00Z' }, broadcastSettings: { language: 'en' } } } };
}

describe('TwitchAdapter GQL per-operation errors', () => {
  function adapterWith(gqlResponses: unknown[], helixStreams: unknown[] | Error) {
    const a = new TwitchAdapter('cid', 'secret') as unknown as Record<string, unknown>;
    a.gqlClient = { post: jest.fn().mockResolvedValue({ data: gqlResponses }) };
    a.client = {
      get: helixStreams instanceof Error
        ? jest.fn().mockRejectedValue(helixStreams)
        : jest.fn().mockResolvedValue({ data: { data: helixStreams } }),
    };
    a.ensureToken = jest.fn().mockResolvedValue(undefined);
    a.accessToken = 'tok';
    a.tokenExpiresAt = Date.now() + 3_600_000;
    return a as unknown as TwitchAdapter;
  }

  it('re-fetches errored channels via Helix instead of reporting them offline', async () => {
    const adapter = adapterWith(
      [gqlOk('kodiak1777', 3700), { errors: [{ message: 'service unavailable' }], data: { user: null } }],
      [{ user_login: 'geoguessr', user_name: 'GeoGuessr', viewer_count: 11947, language: 'en', game_name: 'GeoGuessr', title: 'final', started_at: '2026-09-05T11:00:00Z' }],
    );
    const snaps = await adapter.getViewerCounts(['kodiak1777', 'geoguessr']);
    const geo = snaps.find((s) => s.channelIdentifier === 'geoguessr');
    expect(geo?.isLive).toBe(true);
    expect(geo?.concurrentViewers).toBe(11947);
    expect(geo?.fetchFailed).toBeUndefined();
    expect(snaps.find((s) => s.channelIdentifier === 'kodiak1777')?.concurrentViewers).toBe(3700);
  });

  it('marks channels fetchFailed when both GQL and Helix fail, never offline', async () => {
    const adapter = adapterWith(
      [{ errors: [{ message: 'service timeout' }], data: null }],
      new Error('helix down'),
    );
    const snaps = await adapter.getViewerCounts(['mount']);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].fetchFailed).toBe(true);
    expect(snaps[0].isLive).toBe(false);
  });
});
