#!/usr/bin/env python3
"""Generate a stacked area chart of CCV by region over time.

Input JSON (via stdin):
{
  "data": [
    { "timestamp": "...", "groupKey": "NA", "totalCCV": 8000 },
    { "timestamp": "...", "groupKey": "EU", "totalCCV": 4000 },
    ...
  ],
  "options": {
    "title": "CCV by Region",
    "scopeLabel": "Day 1 — Group Stage"
  },
  "outputPath": "/tmp/charts/{id}/stacked_region.png",
  "configPath": "..."
}
"""

import sys
import os
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chart_helpers import (
    read_stdin_json, load_config, create_figure, set_title, set_axis_labels,
    save_chart, compact_formatter, parse_timestamps, get_color_cycle,
)
import matplotlib.dates as mdates
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
        set_title(ax, options.get('title', 'CCV by Region'), config)
        save_chart(fig, output_path, config)
        return

    # Pivot data: group by timestamp, each region is a column
    time_map = OrderedDict()
    regions = OrderedDict()

    for d in data:
        ts = d['timestamp']
        region = d.get('groupKey', 'Unknown')
        if ts not in time_map:
            time_map[ts] = {}
        time_map[ts][region] = d['totalCCV']
        regions[region] = True

    region_list = list(regions.keys())
    timestamps = parse_timestamps(list(time_map.keys()))
    colors = get_color_cycle('region_colors', config, len(region_list))

    # Build stacked arrays
    stacked = []
    for region in region_list:
        values = [time_map[ts].get(region, 0) for ts in time_map]
        stacked.append(values)

    fig, ax = create_figure(config, height=5.5)

    ax.stackplot(
        timestamps,
        *stacked,
        labels=region_list,
        colors=colors,
        alpha=0.7,
        linewidth=0.5,
        edgecolor='white',
    )

    # Axes
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M'))
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.yaxis.set_major_formatter(compact_formatter())
    ax.set_ylim(bottom=0)

    set_title(ax, options.get('title', 'CCV by Region'), config,
              subtitle=options.get('scopeLabel'))
    set_axis_labels(ax, 'Time', 'Concurrent Viewers', config)

    handles, labels = ax.get_legend_handles_labels()
    ax.legend(handles[::-1], labels[::-1], loc='upper left', fontsize=8,
              framealpha=0.9, ncol=min(len(region_list), 4))

    fig.autofmt_xdate(rotation=30, ha='right')
    save_chart(fig, output_path, config)


if __name__ == '__main__':
    main()
