#!/usr/bin/env python3
"""Generate a donut chart showing CCV distribution by platform.

Input JSON (via stdin):
{
  "data": [
    { "platform": "twitch", "totalCCV": 83000, "avgCCV": 16600, "peakCCV": 21000 },
    { "platform": "youtube", "totalCCV": 54800, "avgCCV": 10960, "peakCCV": 13800 },
    ...
  ],
  "options": {
    "title": "Platform Distribution",
    "scopeLabel": "Day 1 — Group Stage"
  },
  "outputPath": "/tmp/charts/{id}/platform_donut.png",
  "configPath": "..."
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title,
    save_chart, compact_number, platform_color, platform_label,
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
        fig, ax = create_figure(config, half_width=True)
        ax.text(0.5, 0.5, 'No data available', ha='center', va='center',
                fontsize=12, color='#9CA3AF', transform=ax.transAxes)
        ax.axis('off')
        set_title(ax, options.get('title', 'Platform Distribution'), config)
        save_chart(fig, output_path, config)
        return

    # Sort by totalCCV descending
    data = sorted(data, key=lambda d: d['totalCCV'], reverse=True)

    platforms = [d.get('platform', 'unknown') for d in data]
    values = [d['totalCCV'] for d in data]
    colors = [platform_color(p, config) for p in platforms]
    labels = [platform_label(p) for p in platforms]
    grand_total = sum(values) or 1

    inner_radius = config.get('donut_inner_radius', 0.55)

    fig, ax = create_figure(config, width=7, height=5.5)

    wedges, texts, autotexts = ax.pie(
        values,
        labels=None,
        colors=colors,
        autopct=lambda pct: f'{pct:.1f}%' if pct >= 3 else '',
        pctdistance=0.78,
        startangle=90,
        counterclock=False,
        wedgeprops=dict(width=1 - inner_radius, edgecolor='white', linewidth=2),
    )

    # Style auto-text (percentage labels)
    for autotext in autotexts:
        autotext.set_fontsize(9)
        autotext.set_fontweight('bold')
        autotext.set_color('#374151')

    # Center text: total CCV
    ax.text(0, 0.05, compact_number(grand_total),
            ha='center', va='center', fontsize=20, fontweight='bold',
            color=config.get('text_color', '#374151'))
    ax.text(0, -0.12, 'Total CCV',
            ha='center', va='center', fontsize=9,
            color='#9CA3AF')

    # Build legend with CCV values
    legend_labels = [
        f'{label}  {compact_number(val)}  ({val / grand_total * 100:.1f}%)'
        for label, val in zip(labels, values)
    ]
    ax.legend(
        wedges, legend_labels,
        loc='center left',
        bbox_to_anchor=(1.05, 0.5),
        fontsize=9,
        frameon=False,
    )

    ax.axis('equal')
    set_title(ax, options.get('title', 'Platform Distribution'), config,
              subtitle=options.get('scopeLabel'))

    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
