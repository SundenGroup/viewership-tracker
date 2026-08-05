/**
 * Clock-shift detection for CSV viewership imports.
 *
 * Platform exports (Twitch "Stream Session" etc.) carry bare clock times
 * in whatever timezone the EXPORTER's dashboard uses — nothing in the
 * file says which. Interpreting them in the wrong zone slides the whole
 * curve by whole hours, which is invisible in a preview ("the numbers
 * look right") and poisonous in the data (PGS7 Day 1 landed +1h because
 * the export clock was UTC+3, not Berlin).
 *
 * The tracker itself is the antidote: for channels we also poll live
 * (Helix/game-tracker), we hold an independent minute-resolution curve
 * of the same broadcast. Sliding the CSV against that reference and
 * comparing fit at each candidate lag exposes a mis-zoned import as a
 * best fit at a non-zero lag.
 *
 * CCV curves are smooth (high autocorrelation), so a wrong-lag fit can
 * still correlate decently — the verdict therefore demands BOTH a
 * clearly better correlation at the best lag AND a materially lower
 * error than lag zero before it calls the import suspicious.
 */

export interface ClockShiftResult {
  /** False when there wasn't enough overlapping reference data to judge. */
  checked: boolean;
  /** Minutes the CSV appears to be AHEAD of reality (+60 = one hour late in DB). */
  bestLagMinutes: number;
  bestR: number;
  zeroLagR: number;
  /** Mean absolute error ratio best/zero — < 1 means best lag fits tighter. */
  maeRatio: number;
  overlapMinutes: number;
  suspicious: boolean;
}

const NOT_CHECKED: ClockShiftResult = {
  checked: false,
  bestLagMinutes: 0,
  bestR: 0,
  zeroLagR: 0,
  maeRatio: 1,
  overlapMinutes: 0,
  suspicious: false,
};

/** Candidate lags: ±4h in 30-min steps (covers half-hour timezones). */
const LAGS: number[] = [];
for (let m = -240; m <= 240; m += 30) LAGS.push(m);

const MIN_OVERLAP_MINUTES = 30;

function pearson(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) {
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

function fitAtLag(
  csvByMinute: Map<number, number>,
  referenceByMinute: Map<number, number>,
  lagMinutes: number,
): { r: number; mae: number; overlap: number } {
  const pairs: Array<[number, number]> = [];
  let absErr = 0;
  for (const [minute, v] of csvByMinute) {
    // A CSV that is AHEAD by `lag` has its true instant `lag` earlier.
    const ref = referenceByMinute.get(minute - lagMinutes * 60_000);
    if (ref === undefined) continue;
    pairs.push([v, ref]);
    absErr += Math.abs(v - ref);
  }
  if (pairs.length === 0) return { r: 0, mae: Number.POSITIVE_INFINITY, overlap: 0 };
  return { r: pearson(pairs), mae: absErr / pairs.length, overlap: pairs.length };
}

export function detectClockShift(
  csvPoints: Array<{ ts: number; viewers: number }>,
  referenceByMinute: Map<number, number>,
): ClockShiftResult {
  if (referenceByMinute.size < MIN_OVERLAP_MINUTES || csvPoints.length < MIN_OVERLAP_MINUTES) {
    return NOT_CHECKED;
  }
  const csvByMinute = new Map<number, number>();
  for (const p of csvPoints) {
    csvByMinute.set(Math.floor(p.ts / 60_000) * 60_000, p.viewers);
  }

  const zero = fitAtLag(csvByMinute, referenceByMinute, 0);
  let bestLag = 0;
  let best = zero;
  for (const lag of LAGS) {
    if (lag === 0) continue;
    const fit = fitAtLag(csvByMinute, referenceByMinute, lag);
    if (fit.overlap >= MIN_OVERLAP_MINUTES && fit.r > best.r) {
      best = fit;
      bestLag = lag;
    }
  }
  if (zero.overlap < MIN_OVERLAP_MINUTES && best.overlap < MIN_OVERLAP_MINUTES) {
    return NOT_CHECKED;
  }

  const maeRatio =
    best.mae === 0 && zero.mae === 0 ? 1 : zero.mae === 0 ? 1 : best.mae / zero.mae;

  // Suspicious = the curve decisively prefers a non-zero lag: strong fit
  // there, clearly better correlation than lag zero, AND at least a third
  // of the error gone. Smooth-curve autocorrelation makes any single
  // signal too soft on its own.
  const suspicious =
    bestLag !== 0 &&
    best.r >= 0.85 &&
    best.r - zero.r >= 0.1 &&
    maeRatio <= 0.67;

  return {
    checked: true,
    bestLagMinutes: bestLag,
    bestR: round3(best.r),
    zeroLagR: round3(zero.r),
    maeRatio: round3(maeRatio),
    overlapMinutes: best.overlap,
    suspicious,
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Human hint for the corrective timezone. The import interpreted the CSV
 * with `assumedOffsetMinutes` east of UTC and the curve landed
 * `lagMinutes` late. Landed = wall − assumed and true = wall − real, so
 * lag = real − assumed → the export's real clock was assumed + lag
 * (Berlin +120 assumed, +60 late ⇒ UTC+3). Etc/GMT names invert the
 * sign by POSIX convention (UTC+3 = Etc/GMT-3).
 */
export function suggestTimezone(assumedOffsetMinutes: number, lagMinutes: number): string {
  const realOffset = assumedOffsetMinutes + lagMinutes;
  const sign = realOffset >= 0 ? '+' : '-';
  const abs = Math.abs(realOffset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const utcLabel = `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  if (m === 0) {
    // Etc/GMT sign is inverted by POSIX convention.
    return `${utcLabel} (IANA: Etc/GMT${realOffset > 0 ? '-' : '+'}${h})`;
  }
  return utcLabel;
}
