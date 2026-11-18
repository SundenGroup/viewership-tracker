/**
 * The tracker poll loop: polls start on the clock minute, every poll is
 * stamped with the minute it was scheduled for, and a tracker never runs
 * two polls at once.
 *
 * Regression for 2026-11-18: rows were stamped when a poll's reads
 * finished. Every ten minutes the YouTube search pass made one poll about
 * 20 seconds slower, its stamp slid into the next minute, and that minute
 * then held two polls while the one before held none. The one-minute chart
 * added both polls and drew GTA VI at 14 million against 7 million real.
 */
jest.mock('../../src/utils/db', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/game-tracker', () => ({
  __esModule: true,
  findById: jest.fn(async () => ({
    id: 't1',
    slug: 'test',
    status: 'active',
    polling_interval_seconds: 60,
  })),
  findActive: jest.fn(async () => []),
}));

import { GameTrackerService } from '../../src/services/game-tracker-service';

function service(pollSeconds: number[]): { svc: GameTrackerService; stamps: string[]; maxAtOnce: () => number } {
  const svc = new GameTrackerService({} as never, {} as never);
  const stamps: string[] = [];
  let running = 0;
  let maxRunning = 0;
  jest.spyOn(svc, 'runCycle').mockImplementation(async (_id: string, pollAt?: Date) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    stamps.push((pollAt as Date).toISOString().slice(11, 19));
    const seconds = pollSeconds.shift() ?? 10;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    running--;
    return {} as never;
  });
  return { svc, stamps, maxAtOnce: () => maxRunning };
}

describe('tracker poll schedule', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls on the clock minute, whatever second the app started at', async () => {
    jest.setSystemTime(new Date('2026-11-18T15:30:42.000Z'));
    const { svc, stamps } = service([]);
    await svc.startTracker('t1');
    await jest.advanceTimersByTimeAsync(18_000 + 2 * 60_000 + 1_000);
    expect(stamps).toEqual(['15:31:00', '15:32:00', '15:33:00']);
    await svc.stop();
  });

  it('a slow poll keeps its own minute, and the next poll gets the next one', async () => {
    // The app starts at :42, the worst second under the old stamping. The
    // second poll takes 35 s (the ten-minute YouTube pass), the rest 10 s.
    jest.setSystemTime(new Date('2026-11-18T15:30:42.000Z'));
    const { svc, stamps, maxAtOnce } = service([10, 35, 10, 10]);
    await svc.startTracker('t1');
    await jest.advanceTimersByTimeAsync(18_000 + 3 * 60_000 + 1_000);
    expect(stamps).toEqual(['15:31:00', '15:32:00', '15:33:00', '15:34:00']);
    expect(new Set(stamps).size).toBe(stamps.length); // never two polls in one minute
    expect(maxAtOnce()).toBe(1);
    await svc.stop();
  });

  it('a poll that runs past the next poll time skips it instead of running two at once', async () => {
    jest.setSystemTime(new Date('2026-11-18T15:30:42.000Z'));
    const { svc, stamps, maxAtOnce } = service([70, 10, 10]);
    await svc.startTracker('t1');
    await jest.advanceTimersByTimeAsync(18_000 + 3 * 60_000 + 1_000);
    // 15:31 ran until 15:32:10, so 15:32 is skipped and polling resumes at 15:33.
    expect(stamps).toEqual(['15:31:00', '15:33:00', '15:34:00']);
    expect(maxAtOnce()).toBe(1);
    await svc.stop();
  });

  it('stops for good: no poll after stop, even when one was running', async () => {
    jest.setSystemTime(new Date('2026-11-18T15:30:42.000Z'));
    const { svc, stamps } = service([30]);
    await svc.startTracker('t1');
    await jest.advanceTimersByTimeAsync(18_000 + 5_000); // 15:31:05, the first poll is running
    await svc.stop();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(stamps).toEqual(['15:31:00']);
  });
});
