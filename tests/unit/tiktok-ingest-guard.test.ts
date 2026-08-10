/**
 * Ingest guard — scenarios replayed from the real PGS7 incidents:
 * VN official 9,654 → 686 (stale re-emit) → 5,886, and the Esports
 * Official's 131 → 0 zero-on-disconnect at broadcast end.
 */
import { TikTokIngestGuard } from '../../src/services/tiktok-ingest-guard';

const T0 = Date.UTC(2026, 7, 9, 10, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

describe('TikTokIngestGuard', () => {
  it('accepts a first-ever reading and steady traffic', () => {
    const g = new TikTokIngestGuard();
    expect(g.assess('vn', 9000, at(0)).action).toBe('accept');
    expect(g.assess('vn', 9200, at(1)).action).toBe('accept');
    expect(g.assess('vn', 9100, at(2)).action).toBe('accept');
  });

  it('holds a stale re-emit and drops it on recovery (the VN incident)', () => {
    const g = new TikTokIngestGuard();
    g.assess('vn', 9654, at(0));
    const plunge = g.assess('vn', 686, at(1)); // stale cached value re-served
    expect(plunge.action).toBe('defer');
    const recovery = g.assess('vn', 5886, at(2)); // next real read
    expect(recovery.action).toBe('accept');
    expect(recovery).not.toHaveProperty('release'); // artifact never lands
  });

  it('releases a confirmed real decline with its original timestamp', () => {
    const g = new TikTokIngestGuard();
    g.assess('end', 800, at(0));
    expect(g.assess('end', 60, at(1)).action).toBe('defer'); // broadcast ends
    const confirm = g.assess('end', 40, at(2)); // still low → real
    expect(confirm.action).toBe('accept');
    expect(confirm.action === 'accept' && confirm.release?.viewers).toBe(60);
    expect(confirm.action === 'accept' && confirm.release?.timestamp.getTime()).toBe(at(1).getTime());
  });

  it('treats a disconnect zero exactly like a plunge', () => {
    const g = new TikTokIngestGuard();
    g.assess('z', 131, at(0));
    expect(g.assess('z', 0, at(1)).action).toBe('defer');
    expect(g.assess('z', 129, at(2)).action).toBe('accept'); // zero never lands
  });

  it('never guards small channels — their jitter is legitimate', () => {
    const g = new TikTokIngestGuard();
    g.assess('small', 40, at(0));
    expect(g.assess('small', 5, at(1)).action).toBe('accept');
  });

  it('does not distrust after a long silence (no fresh baseline)', () => {
    const g = new TikTokIngestGuard();
    g.assess('idle', 900, at(0));
    // 20 minutes later — tracker was away; whatever comes is the new truth.
    expect(g.assess('idle', 55, at(20)).action).toBe('accept');
  });

  it('expires a held value that never got its second opinion', () => {
    const g = new TikTokIngestGuard();
    g.assess('gone', 700, at(0));
    expect(g.assess('gone', 10, at(1)).action).toBe('defer');
    // Next report only 15 min later: held value is stale state, dropped;
    // and with no fresh baseline the new reading is simply accepted.
    const late = g.assess('gone', 12, at(16));
    expect(late.action).toBe('accept');
    expect(late).not.toHaveProperty('release');
  });
});
