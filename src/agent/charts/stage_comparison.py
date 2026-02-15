#!/usr/bin/env python3
"""Generate a side-by-side bar chart comparing aggregate metrics across stages.

Only used in series scope reports.

Input JSON (via stdin):
{
  "data": [
    {
      "stageName": "Group Stage",
      "peakCCV": 45000,
      "avgCCV": 32000,
      "totalViewedHours": 2400,
      "channelCount": 15
    },
    {
      "stageName": "Grand Finals",
      "peakCCV": 78000,
      "avgCCV": 55000,
      "totalViewedHours": 1800,
      "channelCount": 12
    }
  ],
  "options": {
    "title": "Stage Comparison",
    "scopeLabel": "PEC 2026"
  },
  "outputPath": "/tmp/charts/{id}/stage_comparison.png",
  "configPath": "..."
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title,
    save_chart, compact_formatter, compact_number,
)
import matplotlib.pyplot as plt
import numpy as np


# Colors for each metric
METRIC_COLORS = {
    'peakCCV': '#3b82f6',
    'avgCCV': '#22d3ee',
    'totalViewedHours': '#a78bfa',
}


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
        set_title(ax, options.get('title', 'Stage Comparison'), config)
        save_chart(fig, output_path, config)
        return

    stage_names = [d.get('stageName', f'Stage {i+1}') for i, d in enumerate(data)]
    metrics = ['peakCCV', 'avgCCV', 'totalViewedHours']
    metric_labels = ['Peak CCV', 'Avg CCV', 'Viewed Hours']

    # Create a 1x3 subplot layout for each metric
    fig, axes = plt.subplots(1, 3, figsize=(config['figure_width_full'], 4.5),
                             dpi=config.get('dpi', 300))
    fig.patch.set_facecolor(config.get('background_color', '#FFFFFF'))

    for ax, metric, label in zip(axes, metrics, metric_labels):
        ax.set_facecolor(config.get('background_color', '#FFFFFF'))

        values = [d.get(metric, 0) for d in data]
        x = np.arange(len(stage_names))
        color = METRIC_COLORS.get(metric, '#6B7280')

        bars = ax.bar(x, values, width=0.5, color=color, edgecolor='white',
                      linewidth=0.5, alpha=0.85)

        # Value labels
        ann_size = config.get('font', {}).get('annotation_size', 8)
        max_val = max(values) if values else 1
        for bar, val in zip(bars, values):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(),
                    compact_number(val), ha='center', va='bottom',
                    fontsize=ann_size, fontweight='bold', color='#374151')

        ax.set_xticks(x)
        ax.set_xticklabels(stage_names, fontsize=8, rotation=20 if len(stage_names) > 3 else 0,
                           ha='right' if len(stage_names) > 3 else 'center')
        ax.yaxis.set_major_formatter(compact_formatter())
        ax.set_ylim(bottom=0, top=max_val * 1.2 if max_val > 0 else 1)
        ax.set_title(label, fontsize=11, fontweight='bold',
                     color=config.get('text_color', '#374151'), pad=8)

        # Grid
        ax.grid(True, linestyle='--', alpha=0.4, color=config.get('grid_color', '#E5E7EB'),
                linewidth=0.5, axis='y')
        ax.set_axisbelow(True)

        # Spines
        border_color = config.get('border_color', '#D1D5DB')
        for spine in ax.spines.values():
            spine.set_color(border_color)
            spine.set_linewidth(0.5)

        ax.tick_params(colors=config.get('text_color', '#374151'),
                       labelsize=config.get('font', {}).get('tick_size', 9))

    # Super title
    title_size = config.get('font', {}).get('title_size', 14)
    fig.suptitle(
        options.get('title', 'Stage Comparison'),
        fontsize=title_size, fontweight='bold',
        color=config.get('text_color', '#374151'),
        y=1.02,
    )
    if options.get('scopeLabel'):
        fig.text(0.5, 0.99, options['scopeLabel'],
                 ha='center', fontsize=9, color='#9CA3AF')

    fig.tight_layout()
    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
