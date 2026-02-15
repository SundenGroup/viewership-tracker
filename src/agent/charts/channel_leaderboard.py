#!/usr/bin/env python3
"""Generate a horizontal bar chart of top channels by peak CCV or viewed hours.

Input JSON (via stdin):
{
  "data": [
    {
      "channelId": "...",
      "displayName": "PUBG Esports",
      "platform": "twitch",
      "peakCCV": 21000,
      "avgCCV": 16600,
      "totalViewedMinutes": 83000
    },
    ...
  ],
  "options": {
    "title": "Channel Leaderboard",
    "scopeLabel": "Day 1 — Group Stage",
    "metric": "peakCCV",
    "maxChannels": 20
  },
  "outputPath": "/tmp/charts/{id}/channel_leaderboard.png",
  "configPath": "..."
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title, set_axis_labels,
    save_chart, compact_formatter, compact_number, platform_color, platform_label,
)
import numpy as np


def main():
    payload = read_stdin_json()
    config = load_config(payload.get('configPath'))
    data = payload['data']
    options = payload.get('options', {})
    output_path = payload['outputPath']
    metric = options.get('metric', 'peakCCV')
    max_channels = options.get('maxChannels', 20)

    if not data:
        fig, ax = create_figure(config)
        ax.text(0.5, 0.5, 'No data available', ha='center', va='center',
                fontsize=12, color='#9CA3AF', transform=ax.transAxes)
        set_title(ax, options.get('title', 'Channel Leaderboard'), config)
        save_chart(fig, output_path, config)
        return

    # Sort and limit
    data.sort(key=lambda d: d.get(metric, 0), reverse=True)
    data = data[:max_channels]

    names = [d['displayName'] for d in data]
    values = [d.get(metric, 0) for d in data]
    platforms = [d.get('platform', 'unknown') for d in data]
    colors = [platform_color(p, config) for p in platforms]

    # Truncate long names
    max_name_len = 22
    display_names = [n[:max_name_len] + '...' if len(n) > max_name_len else n for n in names]

    # Dynamic height
    bar_height = max(4, len(data) * 0.4 + 1.5)

    fig, ax = create_figure(config, width=config['figure_width_full'], height=bar_height)

    y_pos = np.arange(len(display_names))
    bar_w = config.get('bar_width', 0.6)

    bars = ax.barh(y_pos, values, height=bar_w, color=colors, edgecolor='white', linewidth=0.5)

    # Value labels
    ann_size = config.get('font', {}).get('annotation_size', 8)
    max_val = max(values) if values else 1
    for bar, val, plat in zip(bars, values, platforms):
        label_text = compact_number(val)
        ax.text(
            bar.get_width() + max_val * 0.01,
            bar.get_y() + bar.get_height() / 2,
            label_text,
            va='center', ha='left',
            fontsize=ann_size, color='#6B7280',
        )

    ax.set_yticks(y_pos)
    ax.set_yticklabels(display_names)
    ax.invert_yaxis()
    ax.xaxis.set_major_formatter(compact_formatter())
    ax.set_xlim(right=max_val * 1.2)

    metric_labels = {
        'peakCCV': 'Peak CCV',
        'avgCCV': 'Average CCV',
        'totalViewedMinutes': 'Total Viewed Minutes',
    }

    set_title(ax, options.get('title', 'Channel Leaderboard'), config,
              subtitle=options.get('scopeLabel'))
    set_axis_labels(ax, metric_labels.get(metric, metric), '', config)

    # Platform legend
    unique_platforms = list(dict.fromkeys(platforms))
    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor=platform_color(p, config), label=platform_label(p))
        for p in unique_platforms
    ]
    ax.legend(handles=legend_elements, loc='lower right', fontsize=8, framealpha=0.9)

    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
