"""Shared helpers for all chart generation scripts.

Loaded by every chart script to provide consistent styling, config parsing,
and output handling.
"""

import json
import sys
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import matplotlib
matplotlib.use('Agg')  # Non-interactive backend for server-side rendering
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import matplotlib.dates as mdates
from matplotlib.figure import Figure
import numpy as np


# ── Config loading ───────────────────────────────────────────────────────────

def load_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """Load chart configuration from JSON file."""
    if config_path is None:
        # Resolve relative to this file: src/agent/charts/ -> config/
        base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)
        ))))
        config_path = os.path.join(base, 'config', 'chart-config.json')

    with open(config_path, 'r') as f:
        return json.load(f)


def read_stdin_json() -> Dict[str, Any]:
    """Read JSON data from stdin (piped from Node.js)."""
    raw = sys.stdin.read()
    return json.loads(raw)


# ── Default platform colors ─────────────────────────────────────────────────

DEFAULT_PLATFORM_COLORS = {
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


def platform_color(platform: str, config: Dict[str, Any]) -> str:
    """Get the color for a platform, falling back to defaults."""
    colors = config.get('platform_colors', DEFAULT_PLATFORM_COLORS)
    return colors.get(platform.lower(), '#6B7280')


def platform_label(platform: str) -> str:
    """Get the display label for a platform."""
    return PLATFORM_LABELS.get(platform.lower(), platform.title())


def get_color_cycle(key: str, config: Dict[str, Any], count: int) -> List[str]:
    """Get a list of colors from config, cycling if needed."""
    palette = config.get(key, [
        '#3b82f6', '#22d3ee', '#a78bfa', '#34d399', '#fbbf24',
        '#fb923c', '#f472b6', '#818cf8', '#2dd4bf', '#e879f9',
    ])
    return [palette[i % len(palette)] for i in range(count)]


# ── Figure creation ──────────────────────────────────────────────────────────

def create_figure(
    config: Dict[str, Any],
    width: Optional[float] = None,
    height: Optional[float] = None,
    half_width: bool = False,
) -> Tuple[Figure, plt.Axes]:
    """Create a matplotlib figure with standard styling."""
    w = width or (config['figure_width_half'] if half_width else config['figure_width_full'])
    h = height or config['figure_height_default']
    dpi = config.get('dpi', 300)

    fig, ax = plt.subplots(figsize=(w, h), dpi=dpi)

    # Background
    fig.patch.set_facecolor(config.get('background_color', '#FFFFFF'))
    ax.set_facecolor(config.get('background_color', '#FFFFFF'))

    # Grid
    ax.grid(
        True,
        linestyle='--',
        alpha=config.get('grid_alpha', 0.5),
        color=config.get('grid_color', '#E5E7EB'),
        linewidth=0.5,
    )
    ax.set_axisbelow(True)

    # Font
    font_family = config.get('font', {}).get('family', 'Arial')
    plt.rcParams['font.family'] = font_family

    # Tick styling
    tick_size = config.get('font', {}).get('tick_size', 9)
    text_color = config.get('text_color', '#374151')
    ax.tick_params(colors=text_color, labelsize=tick_size)

    # Spine styling
    border_color = config.get('border_color', '#D1D5DB')
    for spine in ax.spines.values():
        spine.set_color(border_color)
        spine.set_linewidth(0.5)

    return fig, ax


def set_title(ax: plt.Axes, title: str, config: Dict[str, Any], subtitle: Optional[str] = None):
    """Set chart title with consistent styling."""
    title_size = config.get('font', {}).get('title_size', 14)
    text_color = config.get('text_color', '#374151')

    ax.set_title(title, fontsize=title_size, fontweight='bold', color=text_color, pad=12)
    if subtitle:
        label_size = config.get('font', {}).get('label_size', 10)
        ax.text(
            0.5, 1.02, subtitle,
            transform=ax.transAxes,
            ha='center', va='bottom',
            fontsize=label_size - 1,
            color='#9CA3AF',
        )


def set_axis_labels(ax: plt.Axes, xlabel: str, ylabel: str, config: Dict[str, Any]):
    """Set axis labels with consistent styling."""
    label_size = config.get('font', {}).get('label_size', 10)
    text_color = config.get('text_color', '#374151')
    ax.set_xlabel(xlabel, fontsize=label_size, color=text_color, labelpad=8)
    ax.set_ylabel(ylabel, fontsize=label_size, color=text_color, labelpad=8)


# ── Number formatting ────────────────────────────────────────────────────────

def compact_number(n: float) -> str:
    """Format a number in compact notation: 1234 -> '1.2K', 1234567 -> '1.2M'."""
    if abs(n) >= 1_000_000:
        return f'{n / 1_000_000:.1f}M'
    if abs(n) >= 1_000:
        return f'{n / 1_000:.1f}K'
    return f'{int(round(n))}'


def compact_formatter():
    """Return a matplotlib FuncFormatter for compact numbers."""
    return ticker.FuncFormatter(lambda x, _: compact_number(x))


# ── Timestamp parsing ────────────────────────────────────────────────────────

def parse_timestamps(timestamps: List[str]) -> List[datetime]:
    """Parse ISO 8601 timestamp strings into datetime objects."""
    result = []
    for ts in timestamps:
        # Handle various ISO formats
        ts = ts.replace('Z', '+00:00')
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            # Fallback: strip timezone and parse
            dt = datetime.fromisoformat(ts[:19])
        result.append(dt)
    return result


# ── Save / output ────────────────────────────────────────────────────────────

def save_chart(fig: Figure, output_path: str, config: Dict[str, Any]):
    """Save the chart to a PNG file and close the figure."""
    dpi = config.get('dpi', 300)
    fig.tight_layout()
    fig.savefig(
        output_path,
        dpi=dpi,
        bbox_inches='tight',
        facecolor=fig.get_facecolor(),
        edgecolor='none',
        pad_inches=0.15,
    )
    plt.close(fig)

    # Output the path to stdout so Node.js can read it
    print(json.dumps({'status': 'ok', 'path': output_path}))
