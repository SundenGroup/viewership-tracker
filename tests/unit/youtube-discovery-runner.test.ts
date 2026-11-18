/**
 * The background YouTube search pass: a poll kicks it off and never waits,
 * one pass per tracker at a time, results handed out once.
 */
import { DiscoveryRunner } from '../../src/services/youtube-discovery-runner';
import type { YouTubeLiveCandidate } from '../../src/services/youtube-live-discovery';

const candidate = (videoId: string, roughViewers: number | null = 100): YouTubeLiveCandidate => ({
  videoId,
  channelId: `UC${videoId}`,
  channelTitle: videoId,
  title: `GTA 6 ${videoId}`,
  roughViewers,
});

/** A discover function whose passes finish only when the test says so. */
function controlled() {
  const pending: Array<{ resolve: (c: YouTubeLiveCandidate[]) => void; reject: (e: Error) => void; queries: string[] }> = [];
  const discover = jest.fn(
    (queries: string[]) =>
      new Promise<YouTubeLiveCandidate[]>((resolve, reject) => {
        pending.push({ resolve, reject, queries });
      }),
  );
  return { discover, pending };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('DiscoveryRunner', () => {
  it('starts a pass without waiting for it, and hands the result out once', async () => {
    const { discover, pending } = controlled();
    const runner = new DiscoveryRunner(discover);
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000)).toBe(true);
    expect(runner.take('t1')).toBeNull(); // still searching: the poll goes on without it
    pending[0].resolve([candidate('a'), candidate('b')]);
    await settle();
    expect(runner.take('t1')?.map((c) => c.videoId)).toEqual(['a', 'b']);
    expect(runner.take('t1')).toBeNull();
  });

  it('runs one pass at a time, however long it takes', async () => {
    const { discover, pending } = controlled();
    const runner = new DiscoveryRunner(discover);
    runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000);
    // Twenty minutes later the first pass is still running: no second one.
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000 + 1_200_000)).toBe(false);
    expect(discover).toHaveBeenCalledTimes(1);
    pending[0].resolve([]);
    await settle();
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000 + 1_200_000)).toBe(true);
  });

  it('waits out the interval between passes', async () => {
    const { discover, pending } = controlled();
    const runner = new DiscoveryRunner(discover);
    runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000);
    pending[0].resolve([]);
    await settle();
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000 + 599_000)).toBe(false);
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000 + 600_000)).toBe(true);
  });

  it('keeps trackers apart', async () => {
    const { discover, pending } = controlled();
    const runner = new DiscoveryRunner(discover);
    runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000);
    runner.kick('t2', 'pubg', ['PUBG'], 2, 600_000, 1_000_000);
    pending[1].resolve([candidate('p')]);
    await settle();
    expect(runner.take('t1')).toBeNull();
    expect(runner.take('t2')?.map((c) => c.videoId)).toEqual(['p']);
  });

  it('a failed pass leaves nothing behind and does not block the next one', async () => {
    const { discover, pending } = controlled();
    const runner = new DiscoveryRunner(discover);
    runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000);
    pending[0].reject(new Error('YouTube said no'));
    await settle();
    expect(runner.take('t1')).toBeNull();
    expect(runner.isRunning('t1')).toBe(false);
    expect(runner.kick('t1', 'gtavi', ['GTA 6'], 2, 600_000, 1_000_000 + 600_000)).toBe(true);
  });

  it('does nothing for a tracker with no searches', () => {
    const { discover } = controlled();
    const runner = new DiscoveryRunner(discover);
    expect(runner.kick('t1', 'goals', [], 2, 600_000, 1_000_000)).toBe(false);
    expect(discover).not.toHaveBeenCalled();
  });
});
