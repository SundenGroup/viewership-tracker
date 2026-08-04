/**
 * Quarantine promotion — the pure scope filter.
 *
 * The stakes: 'matching' promotion must agree with what live gating
 * would have counted, including the Unicode look-alike folding, or a
 * reviewer's approval backfills streams the tracker would never have
 * tracked live.
 */
import { selectPromotable } from '../../src/services/youtube-quarantine-promote';
import type { HeldSnapshot } from '../../src/models/game-tracker-youtube-quarantine';

const row = (id: string, title: string | null): HeldSnapshot => ({
  id,
  game_tracker_id: 't1',
  channel_identifier: 'UCabc',
  display_name: 'Chan',
  video_id: `v-${id}`,
  stream_title: title,
  concurrent_viewers: 100,
  language: 'en',
  started_at: null,
  timestamp: new Date('2026-08-04T10:00:00Z'),
});

const cfg = {
  strongPhrases: ['pubg: battlegrounds'],
  strongTags: ['pubg'],
  include: ['pgs7', 'battlegrounds'],
};

describe('selectPromotable', () => {
  it("scope 'all' promotes every held row, titles unread", () => {
    const rows = [row('a', 'Valorant ranked grind'), row('b', null)];
    const { promote, skip } = selectPromotable(rows, 'all', cfg);
    expect(promote).toHaveLength(2);
    expect(skip).toHaveLength(0);
  });

  it("scope 'matching' keeps vocabulary hits and skips the rest", () => {
    const rows = [
      row('a', 'PGS7 Watch Party — Grand Finals'),
      row('b', 'Just Chatting with viewers'),
      row('c', 'PUBG: BATTLEGROUNDS ranked'),
    ];
    const { promote, skip } = selectPromotable(rows, 'matching', cfg);
    expect(promote.map((r) => r.id)).toEqual(['a', 'c']);
    expect(skip.map((r) => r.id)).toEqual(['b']);
  });

  it('folds Unicode look-alike titles the same way live gating does', () => {
    const rows = [row('a', '🅿🆄🅱🅶 battlegrounds duo night')];
    const { promote } = selectPromotable(rows, 'matching', cfg);
    expect(promote).toHaveLength(1);
  });

  it("empty vocabulary under 'matching' promotes nothing — mirrors live gating", () => {
    const rows = [row('a', 'PGS7 Finals')];
    const { promote, skip } = selectPromotable(rows, 'matching', {});
    expect(promote).toHaveLength(0);
    expect(skip).toHaveLength(1);
  });

  it('null titles never match', () => {
    const { promote, skip } = selectPromotable([row('a', null)], 'matching', cfg);
    expect(promote).toHaveLength(0);
    expect(skip).toHaveLength(1);
  });
});
