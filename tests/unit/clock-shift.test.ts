/**
 * Clock-shift guard — modeled on the real 2026-08-05 incident: a Twitch
 * Stream Session export whose clock was UTC+3 got imported as
 * Europe/Berlin (UTC+2), sliding the whole curve +1h versus the
 * independent game-tracker reference.
 */
import { detectClockShift, suggestTimezone } from '../../src/utils/clock-shift';

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 5, 4, 15); // 04:15 UTC — the real stream start

/** A realistic broadcast curve: ramp up, mid-day dip, afternoon peak. */
function curve(minute: number): number {
  return Math.round(
    1500 +
      1400 * Math.sin((minute / 580) * Math.PI) +
      600 * Math.sin((minute / 90) * Math.PI) +
      (minute % 17) * 3,
  );
}

function reference(): Map<number, number> {
  const ref = new Map<number, number>();
  for (let i = 0; i < 580; i++) ref.set(T0 + i * MIN, curve(i));
  return ref;
}

function csvPoints(lagMinutes: number): Array<{ ts: number; viewers: number }> {
  const pts: Array<{ ts: number; viewers: number }> = [];
  for (let i = 0; i < 580; i++) {
    // Small measurement noise so the series aren't artificially identical.
    pts.push({ ts: T0 + (i + lagMinutes) * MIN, viewers: curve(i) + ((i * 7) % 11) - 5 });
  }
  return pts;
}

describe('detectClockShift', () => {
  it('flags a +60 min mis-zoned import decisively', () => {
    const res = detectClockShift(csvPoints(60), reference());
    expect(res.checked).toBe(true);
    expect(res.bestLagMinutes).toBe(60);
    expect(res.suspicious).toBe(true);
    expect(res.bestR).toBeGreaterThan(0.95);
  });

  it('passes a correctly-zoned import untouched', () => {
    const res = detectClockShift(csvPoints(0), reference());
    expect(res.checked).toBe(true);
    expect(res.suspicious).toBe(false);
    expect(res.bestLagMinutes).toBe(0);
  });

  it('detects half-hour zones too', () => {
    const res = detectClockShift(csvPoints(-30), reference());
    expect(res.bestLagMinutes).toBe(-30);
    expect(res.suspicious).toBe(true);
  });

  it('declines to judge without enough reference overlap', () => {
    const tiny = new Map<number, number>([[T0, 100], [T0 + MIN, 110]]);
    const res = detectClockShift(csvPoints(60), tiny);
    expect(res.checked).toBe(false);
    expect(res.suspicious).toBe(false);
  });
});

describe('suggestTimezone', () => {
  it('names UTC+3 for the Berlin-assumed +60 incident', () => {
    // Assumed UTC+2 (120 min), curve landed 60 min late → real clock UTC+3.
    expect(suggestTimezone(120, 60)).toBe('UTC+3 (IANA: Etc/GMT-3)');
  });
  it('handles half-hour zones without an Etc alias', () => {
    expect(suggestTimezone(120, 210)).toBe('UTC+5:30');
  });
});
