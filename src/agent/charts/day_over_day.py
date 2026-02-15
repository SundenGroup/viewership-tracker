#!/usr/bin/env python3
"""Generate a grouped bar chart showing peak CCV and avg CCV per broadcast day.

Used in stage/series scope reports to compare performance across days.

Input JSON (via stdin):
{
  "data": [
    {
      "dayLabel": "Day 1",
      "date": "2026-02-01",
      "peakCCV": 45000,
      "avgCCV": 32000,
      "totalViewedHours": 1200
    },
    ...
  ],
  "options": {
    "title": "Day-over-Day Trend",
    "scopeLabel": "Group Stage"
  },
  "outputPath": "/tmp/charts/{id}/day_over_day.png",
  "configPath": "..."
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title, set_axis_labels,
    save_chart, compact_formatter, compact_number,
)
import matplotlib.pyplot as plt
import numpy as np


def main():
    payload = read_stdin_json()
    config = load_config(payload.get('configPath'))
    data = payload['data']
    options = payload.get('options', {})
    output_path = payload['outputPath']

    if not data:
        fig, ax = create_figure(config)
        ax.text(0.5, 0.5, 'No data available', ha='center', va='center',
                fontsize=12, color='#9CA3AF', transform=ax.transAxes)
        set_title(ax, options.get('title', 'Day-over-Day Trend'), config)
        save_chart(fig, output_path, config)
        return

    labels = [d.get('dayLabel', d.get('date', f'Day {i+1}')) for i, d in enumerate(data)]
    peak_values = [d.get('peakCCV', 0) for d in data]
    avg_values = [d.get('avgCCV', 0) for d in data]

    x = np.arange(len(labels))
    bar_width = 0.35

    fig, ax = create_figure(config, height=5)

    bars_peak = ax.bar(x - bar_width / 2, peak_values, bar_width,
                       label='Peak CCV', color='#3b82f6', edgecolor='white', linewidth=0.5)
    bars_avg = ax.bar(x + bar_width / 2, avg_values, bar_width,
                      label='Avg CCV', color='#22d3ee', edgecolor='white', linewidth=0.5)

    # Value labels on top of bars
    ann_size = config.get('font', {}).get('annotation_size', 8)
    for bar in bars_peak:
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, height,
                compact_number(height), ha='center', va='bottom',
                fontsize=ann_size, color='#374151', fontweight='bold')

    for bar in bars_avg:
        height = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, height,
                compact_number(height), ha='center', va='bottom',
                fontsize=ann_size, color='#6B7280')

    # Trend line connecting peak values
    if len(peak_values) > 1:
        ax.plot(x, peak_values, color='#3b82f6', linewidth=1.2, linestyle='--',
                alpha=0.5, marker='o', markersize=4, zorder=5)

    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=30 if len(labels) > 5 else 0, ha='right' if len(labels) > 5 else 'center')
    ax.yaxis.set_major_formatter(compact_formatter())
    ax.set_ylim(bottom=0, top=max(peak_values) * 1.15 if peak_values else 1)

    set_title(ax, options.get('title', 'Day-over-Day Trend'), config,
              subtitle=options.get('scopeLabel'))
    set_axis_labels(ax, '', 'Concurrent Viewers', config)

    ax.legend(loc='upper right', fontsize=9, framealpha=0.9)

    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
