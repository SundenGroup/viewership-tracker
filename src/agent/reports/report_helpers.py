"""Shared helpers for report generation scripts.

Provides common data formatting, config loading, and branding utilities
used by the DOCX, PDF, and XLSX builders.
"""

import json
import sys
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


def read_stdin_json() -> Dict[str, Any]:
    """Read JSON payload from stdin."""
    raw = sys.stdin.read()
    return json.loads(raw)


def load_branding(branding_path: Optional[str] = None) -> Dict[str, Any]:
    """Load branding configuration.

    Falls back to defaults if no branding config is found.
    """
    if branding_path and os.path.isfile(branding_path):
        with open(branding_path, 'r') as f:
            return json.load(f)

    # Default branding
    return {
        'company_name': 'Clutch Group',
        'accent_color': '#3b82f6',
        'accent_color_rgb': (59, 130, 246),
        'header_bg_color': '#1e293b',
        'header_bg_color_rgb': (30, 41, 59),
        'text_color': '#374151',
        'text_color_rgb': (55, 65, 81),
        'muted_color': '#9CA3AF',
        'muted_color_rgb': (156, 163, 175),
        'table_header_bg': '#1e293b',
        'table_header_bg_rgb': (30, 41, 59),
        'table_header_text': '#FFFFFF',
        'table_header_text_rgb': (255, 255, 255),
        'table_alt_row_bg': '#F9FAFB',
        'table_alt_row_bg_rgb': (249, 250, 251),
        'font_family': 'Arial',
        'logo_path': None,
        'partner_logo_path': None,
    }


def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """Convert hex color string to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


# ── Platform Helpers ─────────────────────────────────────────────────────────

PLATFORM_COLORS = {
    'twitch': '#9146FF',
    'youtube': '#FF0000',
    'kick': '#53FC18',
    'tiktok': '#010101',
}

PLATFORM_LABELS = {
    'twitch': 'Twitch',
    'youtube': 'YouTube',
    'kick': 'Kick',
    'tiktok': 'TikTok',
}

TIER_LABELS = {
    'primary': 'Primary',
    'secondary': 'Secondary',
    'community': 'Community',
    'watch_party': 'Watch Party',
}


def platform_label(platform: str) -> str:
    return PLATFORM_LABELS.get(platform, platform.title() if platform else 'Unknown')


def tier_label(tier: str) -> str:
    return TIER_LABELS.get(tier, tier.title() if tier else 'N/A')


# ── Number Formatting ────────────────────────────────────────────────────────

def compact_number(n: float) -> str:
    """Format number compactly: 1234 -> '1.2K', 1234567 -> '1.2M'."""
    if n is None:
        return '0'
    if abs(n) >= 1_000_000:
        return f'{n / 1_000_000:.1f}M'
    if abs(n) >= 1_000:
        return f'{n / 1_000:.1f}K'
    return f'{int(round(n)):,}'


def format_number(n: float) -> str:
    """Format number with thousands separators."""
    if n is None:
        return '0'
    return f'{int(round(n)):,}'


def format_hours(hours: float) -> str:
    """Format hours as 'Xh Ym'."""
    if hours is None or hours == 0:
        return '0h'
    h = int(hours)
    m = int(round((hours - h) * 60))
    if h == 0:
        return f'{m}m'
    if m == 0:
        return f'{h}h'
    return f'{h}h {m}m'


def format_date(iso: Optional[str]) -> str:
    """Format ISO date string to readable date."""
    if not iso:
        return '—'
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%b %d, %Y')
    except (ValueError, AttributeError):
        return iso[:10] if iso else '—'


def format_datetime(iso: Optional[str]) -> str:
    """Format ISO datetime string to readable datetime."""
    if not iso:
        return '—'
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%b %d, %Y %I:%M %p')
    except (ValueError, AttributeError):
        return iso


# ── Aggregate Helpers ────────────────────────────────────────────────────────

def aggregate_metrics(metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate metrics across multiple broadcast days into summary stats."""
    if not metrics:
        return {
            'peakCCV': 0,
            'peakTimestamp': None,
            'avgCCV': 0,
            'totalViewedHours': 0,
            'platformBreakdown': [],
            'languageBreakdown': [],
            'regionBreakdown': [],
            'channelLeaderboard': [],
        }

    # Overall peak
    peak = max(metrics, key=lambda m: m.get('peakCCV', 0))
    overall_peak = peak.get('peakCCV', 0)
    overall_peak_ts = peak.get('peakTimestamp')

    # Average of averages (weighted would be better but this is a reasonable approximation)
    avg_ccv = sum(m.get('avgCCV', 0) for m in metrics) / len(metrics) if metrics else 0

    # Total viewed hours
    total_hours = sum(m.get('totalViewedHours', 0) for m in metrics)

    # Merge platform breakdowns
    platform_map = {}
    for m in metrics:
        for p in m.get('platformBreakdown', []):
            key = p.get('platform', 'unknown')
            if key not in platform_map:
                platform_map[key] = {'platform': key, 'totalCCV': 0, 'avgCCV': 0, 'peakCCV': 0, '_count': 0}
            platform_map[key]['totalCCV'] += p.get('totalCCV', 0)
            platform_map[key]['avgCCV'] += p.get('avgCCV', 0)
            platform_map[key]['peakCCV'] = max(platform_map[key]['peakCCV'], p.get('peakCCV', 0))
            platform_map[key]['_count'] += 1
    for v in platform_map.values():
        if v['_count'] > 0:
            v['avgCCV'] = v['avgCCV'] / v['_count']
        del v['_count']

    # Merge language breakdowns
    lang_map = {}
    for m in metrics:
        for l in m.get('languageBreakdown', []):
            key = l.get('language', 'unknown')
            if key not in lang_map:
                lang_map[key] = {'language': key, 'totalCCV': 0, 'avgCCV': 0, 'peakCCV': 0, '_count': 0}
            lang_map[key]['totalCCV'] += l.get('totalCCV', 0)
            lang_map[key]['avgCCV'] += l.get('avgCCV', 0)
            lang_map[key]['peakCCV'] = max(lang_map[key]['peakCCV'], l.get('peakCCV', 0))
            lang_map[key]['_count'] += 1
    for v in lang_map.values():
        if v['_count'] > 0:
            v['avgCCV'] = v['avgCCV'] / v['_count']
        del v['_count']

    # Merge region breakdowns
    region_map = {}
    for m in metrics:
        for r in m.get('regionBreakdown', []):
            key = r.get('region', 'unknown')
            if key not in region_map:
                region_map[key] = {'region': key, 'totalCCV': 0, 'avgCCV': 0, 'peakCCV': 0, '_count': 0}
            region_map[key]['totalCCV'] += r.get('totalCCV', 0)
            region_map[key]['avgCCV'] += r.get('avgCCV', 0)
            region_map[key]['peakCCV'] = max(region_map[key]['peakCCV'], r.get('peakCCV', 0))
            region_map[key]['_count'] += 1
    for v in region_map.values():
        if v['_count'] > 0:
            v['avgCCV'] = v['avgCCV'] / v['_count']
        del v['_count']

    # Merge channel leaderboards (take best per channel)
    channel_map = {}
    for m in metrics:
        for ch in m.get('channelLeaderboard', []):
            cid = ch.get('channelId', '')
            if cid not in channel_map or ch.get('peakCCV', 0) > channel_map[cid].get('peakCCV', 0):
                channel_map[cid] = ch

    return {
        'peakCCV': overall_peak,
        'peakTimestamp': overall_peak_ts,
        'avgCCV': round(avg_ccv),
        'totalViewedHours': round(total_hours, 2),
        'platformBreakdown': sorted(platform_map.values(), key=lambda x: x['totalCCV'], reverse=True),
        'languageBreakdown': sorted(lang_map.values(), key=lambda x: x['totalCCV'], reverse=True),
        'regionBreakdown': sorted(region_map.values(), key=lambda x: x['totalCCV'], reverse=True),
        'channelLeaderboard': sorted(channel_map.values(), key=lambda x: x.get('peakCCV', 0), reverse=True),
    }


def build_scope_label(payload: Dict[str, Any]) -> str:
    """Build a human-readable scope label from the payload."""
    scope = payload.get('scope', '')
    series_name = payload.get('series', {}).get('name', 'Unknown Series')
    stages = payload.get('stages', [])
    days = payload.get('broadcastDays', [])

    if scope == 'day' and days:
        day = days[0]
        stage = next((s for s in stages if s['id'] == day.get('stageId')), None)
        stage_name = stage['name'] if stage else ''
        return f"{day.get('label', 'Day')} · {stage_name}" if stage_name else day.get('label', 'Day')
    elif scope == 'stage' and stages:
        return stages[0].get('name', 'Stage')
    elif scope == 'series':
        return series_name
    elif scope == 'multi_stage':
        return ', '.join(s.get('name', '') for s in stages)
    else:
        return series_name
