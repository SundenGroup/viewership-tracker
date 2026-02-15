#!/usr/bin/env python3
"""Generate a horizontal bar chart of viewed hours by region.

Input JSON (via stdin):
{
  "data": [
    { "region": "Global", "totalCCV": 137800, "avgCCV": 13780, "peakCCV": 21000 },
    { "region": "NA", "totalCCV": 21900, "avgCCV": 4380, "peakCCV": 5700 },
    ...
  ],
  "options": {
    "title": "Region Distribution",
    "scopeLabel": "Day 1 — Group Stage",
    "metric": "totalCCV"
  },
  "outputPath": "/tmp/charts/{id}/region_bars.png",
  "configPath": "..."
}
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title, set_axis_labels,
    save_chart, compact_formatter, compact_number, get_color_cycle,
)
import numpy as np


def main():
    payload = read_stdin_json()
    config = load_config(payload.get('configPath'))
    data = payload['data']
    options = payload.get('options', {})
    output_path = payload['outputPath']
    metric = options.get('metric', 'totalCCV')

    if not data:
        fig, ax = create_figure(config, half_width=True)
        ax.text(0.5, 0.5, 'No data available', ha='center', va='center',
                fontsize=12, color='#9CA3AF', transform=ax.transAxes)
        set_title(ax, options.get('title', 'Region Distribution'), config)
        save_chart(fig, output_path, config)
        return

    # Filter and sort
    filtered = [d for d in data if d.get('region')]
    filtered.sort(key=lambda d: d.get(metric, 0), reverse=True)

    labels = [d['region'] or 'Unknown' for d in filtered]
    values = [d.get(metric, 0) for d in filtered]
    grand_total = sum(values) or 1
    colors = get_color_cycle('region_colors', config, len(filtered))

    bar_height = max(3.5, len(filtered) * 0.45 + 1.5)

    fig, ax = create_figure(config, width=config['figure_width_full'], height=bar_height)

    y_pos = np.arange(len(labels))
    bar_width = config.get('bar_width', 0.6)

    bars = ax.barh(y_pos, values, height=bar_width, color=colors, edgecolor='white', linewidth=0.5)

    ann_size = config.get('font', {}).get('annotation_size', 8)
    for bar, val in zip(bars, values):
        pct = val / grand_total * 100
        ax.text(
            bar.get_width() + max(values) * 0.01,
            bar.get_y() + bar.get_height() / 2,
            f'{compact_number(val)}  ({pct:.1f}%)',
            va='center', ha='left',
            fontsize=ann_size, color='#6B7280',
        )

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels)
    ax.invert_yaxis()
    ax.xaxis.set_major_formatter(compact_formatter())
    ax.set_xlim(right=max(values) * 1.25)

    metric_label = {
        'totalCCV': 'Total CCV',
        'avgCCV': 'Average CCV',
        'peakCCV': 'Peak CCV',
    }.get(metric, metric)

    set_title(ax, options.get('title', 'Region Distribution'), config,
              subtitle=options.get('scopeLabel'))
    set_axis_labels(ax, metric_label, '', config)

    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
