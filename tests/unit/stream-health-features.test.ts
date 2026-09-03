import { targetStatsFromFeatures } from '../../src/services/stream-health';

const base = {
  platform: 'twitch',
  ccv_minutes: 60_000,
  followers_start: 1000,
  followers_end: 1120,
};

describe('targetStatsFromFeatures', () => {
  it('derives the scorer inputs from stored features', () => {
    const stats = targetStatsFromFeatures({
      ...base,
      health_features: {
        snapMinutes: 120, chatMinutes: 100, meanCcv: 500, sdCcv: 100,
        engRatio: 0.031, rises: [0.2, 0.1], computedAt: '2026-09-03T00:00:00Z',
      },
    });
    expect(stats).not.toBeNull();
    expect(stats!.engRatio).toBeCloseTo(0.031);
    expect(stats!.cv).toBeCloseTo(0.2);
    expect(stats!.convPer1k).toBeCloseTo(2); // 120 followers per 60k viewer-minutes
    expect(stats!.snapMinutes).toBe(120);
    expect(stats!.chatMinutes).toBe(100);
  });

  it('is null without chat evidence or below the coverage gate', () => {
    expect(targetStatsFromFeatures({
      ...base,
      health_features: { snapMinutes: 120, chatMinutes: 0, meanCcv: 500, sdCcv: 50, engRatio: null, rises: [], computedAt: '' },
    })).toBeNull();
    expect(targetStatsFromFeatures({
      ...base,
      health_features: { snapMinutes: 120, chatMinutes: 30, meanCcv: 500, sdCcv: 50, engRatio: 0.02, rises: [], computedAt: '' },
    })).toBeNull();
    expect(targetStatsFromFeatures({ ...base, health_features: null })).toBeNull();
  });

  it('keeps follower conversion neutral on platforms with rounded follower counts', () => {
    const yt = targetStatsFromFeatures({
      ...base,
      platform: 'youtube',
      health_features: { snapMinutes: 120, chatMinutes: 120, meanCcv: 500, sdCcv: 50, engRatio: 0.01, rises: [], computedAt: '' },
    });
    expect(yt!.convPer1k).toBeNull();
    const flat = targetStatsFromFeatures({
      ...base,
      health_features: { snapMinutes: 120, chatMinutes: 120, meanCcv: 0, sdCcv: 0, engRatio: 0.01, rises: [], computedAt: '' },
    });
    expect(flat!.cv).toBeNull();
  });
});
