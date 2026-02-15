#!/usr/bin/env python3
"""Generate a Total CCV over time line chart.

Input JSON (via stdin):
{
  "data": [{ "timestamp": "...", "totalCCV": 12345, "channelCount": 3 }, ...],
  "options": {
    "title": "CCV Over Time",
    "scopeLabel": "Day 1 — Group Stage",
    "showPlatformOverlay": false,
    "platformData": { "twitch": [...], "youtube": [...] },
    "annotations": [{ "timestamp": "...", "label": "Map 3 Start" }],
    "daySeparators": [{ "timestamp": "...", "label": "Day 2" }]
  },
  "outputPath": "/tmp/charts/{id}/time_series.png",
  "configPath": "/path/to/chart-config.json"
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title, set_axis_labels,
    save_chart, compact_formatter, parse_timestamps, platform_color,
    platform_label, compact_number,
)
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np


def main():
    payload = read_stdin_json()
    config = load_config(payload.get('configPath'))
    data = payload['data']
    options = payload.get('options', {})
    output_path = payload['outputPath']

    if not data:
        # Empty chart
        fig, ax = create_figure(config)
        ax.text(0.5, 0.5, 'No data available', ha='center', va='center',
                fontsize=12, color='#9CA3AF', transform=ax.transAxes)
        set_title(ax, options.get('title', 'CCV Over Time'), config)
        save_chart(fig, output_path, config)
        return

    timestamps = parse_timestamps([d['timestamp'] for d in data])
    ccv_values = [d['totalCCV'] for d in data]
    channel_counts = [d.get('channelCount', 0) for d in data]

    fig, ax = create_figure(config, height=5.5)

    # Main CCV line with fill
    ax.plot(timestamps, ccv_values, color='#3b82f6', linewidth=1.8, zorder=3, label='Total CCV')
    ax.fill_between(timestamps, ccv_values, alpha=0.15, color='#3b82f6', zorder=2)

    # Platform overlay lines
    if options.get('showPlatformOverlay') and options.get('platformData'):
        for plat, plat_data in options['platformData'].items():
            plat_ts = parse_timestamps([d['timestamp'] for d in plat_data])
            plat_ccv = [d['totalCCV'] for d in plat_data]
            color = platform_color(plat, config)
            ax.plot(plat_ts, plat_ccv, color=color, linewidth=1.2, alpha=0.7,
                    linestyle='--', label=platform_label(plat), zorder=3)

    # Day separators (for multi-day scope)
    if options.get('daySeparators'):
        for sep in options['daySeparators']:
            sep_ts = parse_timestamps([sep['timestamp']])[0]
            ax.axvline(sep_ts, color='#9CA3AF', linestyle=':', linewidth=0.8, alpha=0.6, zorder=1)
            ax.text(
                sep_ts, ax.get_ylim()[1] * 0.98, f"  {sep.get('label', '')}",
                fontsize=config.get('font', {}).get('annotation_size', 8),
                color='#6B7280', va='top', ha='left',
            )

    # Annotations (event moments)
    if options.get('annotations'):
        ann_size = config.get('font', {}).get('annotation_size', 8)
        for ann in options['annotations']:
            ann_ts = parse_timestamps([ann['timestamp']])[0]
            # Find the CCV at this timestamp (nearest)
            min_idx = min(range(len(timestamps)),
                         key=lambda i: abs((timestamps[i] - ann_ts).total_seconds()))
            ann_ccv = ccv_values[min_idx]
            ax.annotate(
                ann['label'],
                xy=(ann_ts, ann_ccv),
                xytext=(0, 20),
                textcoords='offset points',
                fontsize=ann_size,
                color='#374151',
                arrowprops=dict(arrowstyle='->', color='#9CA3AF', lw=0.8),
                ha='center',
                bbox=dict(boxstyle='round,pad=0.3', facecolor='#F9FAFB', edgecolor='#D1D5DB', lw=0.5),
            )

    # Peak marker
    peak_idx = np.argmax(ccv_values)
    peak_val = ccv_values[peak_idx]
    peak_ts = timestamps[peak_idx]
    ax.plot(peak_ts, peak_val, 'o', color='#ef4444', markersize=6, zorder=5)
    ax.annotate(
        f'Peak: {compact_number(peak_val)}',
        xy=(peak_ts, peak_val),
        xytext=(0, 14),
        textcoords='offset points',
        fontsize=config.get('font', {}).get('annotation_size', 8),
        fontweight='bold',
        color='#ef4444',
        ha='center',
        zorder=5,
    )

    # Axes formatting
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.yaxis.set_major_formatter(compact_formatter())
    ax.set_ylim(bottom=0)

    set_title(ax, options.get('title', 'CCV Over Time'), config,
              subtitle=options.get('scopeLabel'))
    set_axis_labels(ax, 'Time', 'Concurrent Viewers', config)

    if options.get('showPlatformOverlay') and options.get('platformData'):
        ax.legend(loc='upper left', fontsize=8, framealpha=0.9)

    fig.autofmt_xdate(rotation=30, ha='right')
    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
