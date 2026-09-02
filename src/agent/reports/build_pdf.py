#!/usr/bin/env python3
"""Build a PDF report from report payload + chart images using ReportLab.

Input JSON (via stdin) — same shape as build_docx.py.
"""

import sys
import os
import json
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report_helpers import (
    read_stdin_json, load_branding, hex_to_rgb,
    platform_label, tier_label,
    compact_number, format_number, format_hours, format_date, format_datetime,
    aggregate_metrics, build_scope_label,
)

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import inch, cm, mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle,
    PageBreak, KeepTogether,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# ── Helpers ──────────────────────────────────────────────────────────────────

# Reportlab uses PostScript font names, not system font names.
# Map common system fonts to their PostScript equivalents.
FONT_MAP = {
    'arial': 'Helvetica',
    'times new roman': 'Times-Roman',
    'times': 'Times-Roman',
    'courier new': 'Courier',
    'courier': 'Courier',
    'verdana': 'Helvetica',
    'georgia': 'Times-Roman',
    'trebuchet ms': 'Helvetica',
    'tahoma': 'Helvetica',
}

# Reportlab built-in font families
REPORTLAB_FONTS = {'Helvetica', 'Times-Roman', 'Courier', 'Symbol', 'ZapfDingbats'}


def map_font(font_name: str) -> str:
    """Map a system font name to a reportlab-compatible PostScript font name."""
    if font_name in REPORTLAB_FONTS:
        return font_name
    mapped = FONT_MAP.get(font_name.lower())
    if mapped:
        return mapped
    return 'Helvetica'  # Safe fallback


def rgb_color(hex_str: str) -> colors.Color:
    """Convert hex string to reportlab Color."""
    r, g, b = hex_to_rgb(hex_str)
    return colors.Color(r / 255, g / 255, b / 255)


def build_styles(branding: Dict) -> Dict[str, ParagraphStyle]:
    """Build custom paragraph styles."""
    base = getSampleStyleSheet()
    font = map_font(branding.get('font_family', 'Helvetica'))
    accent = branding.get('accent_color', '#3b82f6')
    text_c = branding.get('text_color', '#374151')
    muted_c = branding.get('muted_color', '#9CA3AF')

    return {
        'cover_company': ParagraphStyle(
            'cover_company', parent=base['Normal'],
            fontName=font, fontSize=12, textColor=rgb_color(muted_c),
            alignment=TA_CENTER, spaceAfter=6,
        ),
        'cover_title': ParagraphStyle(
            'cover_title', parent=base['Normal'],
            fontName=font, fontSize=28, textColor=rgb_color(accent),
            alignment=TA_CENTER, spaceAfter=12, leading=34,
        ),
        'cover_series': ParagraphStyle(
            'cover_series', parent=base['Normal'],
            fontName=font, fontSize=18, textColor=rgb_color(text_c),
            alignment=TA_CENTER, spaceAfter=8, leading=22,
        ),
        'cover_meta': ParagraphStyle(
            'cover_meta', parent=base['Normal'],
            fontName=font, fontSize=10, textColor=rgb_color(muted_c),
            alignment=TA_CENTER, spaceAfter=4,
        ),
        'heading1': ParagraphStyle(
            'heading1', parent=base['Heading1'],
            fontName=font, fontSize=16, textColor=rgb_color(text_c),
            spaceAfter=8, spaceBefore=20, leading=20,
        ),
        'heading2': ParagraphStyle(
            'heading2', parent=base['Heading2'],
            fontName=font, fontSize=13, textColor=rgb_color(text_c),
            spaceAfter=6, spaceBefore=14, leading=16,
        ),
        'body': ParagraphStyle(
            'body', parent=base['Normal'],
            fontName=font, fontSize=10, textColor=rgb_color(text_c),
            spaceAfter=6, leading=14,
        ),
        'body_muted': ParagraphStyle(
            'body_muted', parent=base['Normal'],
            fontName=font, fontSize=9, textColor=rgb_color(muted_c),
            spaceAfter=4, leading=12,
        ),
        'footer': ParagraphStyle(
            'footer', parent=base['Normal'],
            fontName=font, fontSize=8, textColor=rgb_color(muted_c),
            alignment=TA_CENTER,
        ),
    }


def make_table(headers: List[str], rows: List[List[str]], branding: Dict,
               col_widths: Optional[List[float]] = None) -> Table:
    """Create a styled table."""
    data = [headers] + rows
    tbl = Table(data, colWidths=col_widths, repeatRows=1)

    header_bg = rgb_color(branding.get('table_header_bg', '#1e293b'))
    alt_bg = rgb_color(branding.get('table_alt_row_bg', '#F9FAFB'))

    style_cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), header_bg),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.Color(0.85, 0.85, 0.85)),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]

    # Alternating row colors
    for i in range(1, len(data)):
        if i % 2 == 0:
            style_cmds.append(('BACKGROUND', (0, i), (-1, i), alt_bg))

    tbl.setStyle(TableStyle(style_cmds))
    return tbl


def add_chart(elements: List, chart_path: str, max_width: float = 6.0 * inch):
    """Add a chart image to the elements list if file exists.

    Default max_width 6.0 inches (432pt) fits within A4 frame with 2.5cm margins
    (available frame width ≈ 441pt). Height is auto-calculated from aspect ratio.
    """
    if chart_path and os.path.isfile(chart_path):
        try:
            from PIL import Image as PILImage
            with PILImage.open(chart_path) as pil_img:
                orig_w, orig_h = pil_img.size
                ratio = orig_h / orig_w
                img_width = min(max_width, orig_w)
                img_height = img_width * ratio
                # Limit height to ~9 inches to avoid page overflow
                max_height = 9.0 * inch
                if img_height > max_height:
                    img_height = max_height
                    img_width = img_height / ratio
        except Exception:
            # Fallback: use fixed dimensions
            img_width = max_width
            img_height = max_width * 0.6

        img = Image(chart_path, width=img_width, height=img_height)
        img.hAlign = 'CENTER'
        elements.append(img)
        elements.append(Spacer(1, 12))


# ── Page callbacks ───────────────────────────────────────────────────────────

def make_page_callbacks(branding: Dict, report_title: str):
    """Create header/footer callbacks for every page."""

    def on_page(canvas, doc):
        canvas.saveState()
        # Footer
        company = branding.get('company_name', 'Clutch Group')
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(rgb_color(branding.get('muted_color', '#9CA3AF')))
        canvas.drawCentredString(
            A4[0] / 2, 1.5 * cm,
            f'Page {doc.page}  |  {company}'
        )
        # Header (skip first page)
        if doc.page > 1:
            canvas.setFont('Helvetica', 7)
            canvas.drawString(2.5 * cm, A4[1] - 1.2 * cm, company)
            canvas.drawRightString(A4[0] - 2.5 * cm, A4[1] - 1.2 * cm, report_title)
            canvas.setStrokeColor(rgb_color(branding.get('border_color', '#D1D5DB')))
            canvas.line(2.5 * cm, A4[1] - 1.4 * cm, A4[0] - 2.5 * cm, A4[1] - 1.4 * cm)
        canvas.restoreState()

    return on_page


# ── Build Document ───────────────────────────────────────────────────────────

def build_pdf(input_data: Dict):
    payload = input_data['payload']
    charts = input_data.get('charts', {})
    narratives = input_data.get('narratives', {})
    options = input_data.get('options', {})
    branding = input_data.get('branding', load_branding())
    output_path = input_data['outputPath']

    scope = options.get('scope', payload.get('scope', 'series'))
    scope_label = build_scope_label(payload)
    agg = aggregate_metrics(payload.get('metrics', []))
    series = payload.get('series', {})
    styles = build_styles(branding)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    report_title = f"Viewership Report: {series.get('name', 'Report')}"
    on_page = make_page_callbacks(branding, report_title)

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        leftMargin=2.5 * cm,
        rightMargin=2.5 * cm,
    )

    elements = []

    # ── Cover page ──
    elements.append(Spacer(1, 2.5 * inch))
    elements.append(Paragraph(branding.get('company_name', 'Clutch Group'), styles['cover_company']))

    # Logo
    logo_path = branding.get('logo_path')
    if logo_path and os.path.isfile(logo_path):
        img = Image(logo_path, width=1.5 * inch)
        img.hAlign = 'CENTER'
        elements.append(img)
        elements.append(Spacer(1, 12))

    elements.append(Paragraph('Viewership Report', styles['cover_title']))
    elements.append(Paragraph(series.get('name', 'Unknown Series'), styles['cover_series']))
    elements.append(Paragraph(scope_label, styles['cover_meta']))

    meta_parts = []
    if series.get('game'):
        meta_parts.append(series['game'])
    if series.get('partner'):
        meta_parts.append(f"Partner: {series['partner']}")
    if meta_parts:
        elements.append(Paragraph(' | '.join(meta_parts), styles['cover_meta']))

    start = format_date(series.get('startDate'))
    end = format_date(series.get('endDate'))
    if start != '—' or end != '—':
        elements.append(Paragraph(f'{start} – {end}', styles['cover_meta']))

    gen = format_datetime(payload.get('generatedAt', ''))
    elements.append(Spacer(1, 24))
    elements.append(Paragraph(f'Generated: {gen}', styles['body_muted']))
    elements.append(PageBreak())

    # ── Executive Summary ──
    if narratives.get('executive_summary'):
        elements.append(Paragraph('Executive Summary', styles['heading1']))
        elements.append(Paragraph(narratives['executive_summary'], styles['body']))
        elements.append(Spacer(1, 12))

    # ── Key Metrics ──
    elements.append(Paragraph('Key Metrics', styles['heading1']))

    channels = payload.get('channels', [])
    days = payload.get('broadcastDays', [])
    metrics_rows = [
        ['Peak CCV', compact_number(agg['peakCCV'])],
        ['Peak Timestamp', format_datetime(agg.get('peakTimestamp'))],
        ['Average CCV', compact_number(agg['avgCCV'])],
        ['Total Viewed Hours', format_number(agg['totalViewedHours'])],
        ['Tracked Channels', str(len(channels))],
        ['Broadcast Days', str(len(days))],
        ['Total Snapshots', format_number(payload.get('snapshotCount', 0))],
    ]
    tbl = make_table(['Metric', 'Value'], metrics_rows, branding,
                     col_widths=[3 * inch, 2.5 * inch])
    elements.append(tbl)
    elements.append(Spacer(1, 16))

    # ── Viewership Timeline ──
    if 'timeSeries' in charts:
        elements.append(Paragraph('Viewership Timeline', styles['heading1']))
        if narratives.get('viewership_timeline'):
            elements.append(Paragraph(narratives['viewership_timeline'], styles['body']))
        add_chart(elements, charts['timeSeries'])

    # ── Platform Analysis ──
    elements.append(Paragraph('Platform Analysis', styles['heading1']))
    if narratives.get('platform_analysis'):
        elements.append(Paragraph(narratives['platform_analysis'], styles['body']))
    if 'platformDonut' in charts:
        add_chart(elements, charts['platformDonut'])

    platforms = agg.get('platformBreakdown', [])
    if platforms:
        plat_rows = [
            [platform_label(p.get('platform', '')),
             format_number(p.get('totalCCV', 0)),
             format_number(p.get('avgCCV', 0)),
             format_number(p.get('peakCCV', 0))]
            for p in platforms
        ]
        tbl = make_table(['Platform', 'Total CCV', 'Avg CCV', 'Peak CCV'], plat_rows, branding)
        elements.append(tbl)
        elements.append(Spacer(1, 16))

    # ── Audience Breakdown ──
    elements.append(Paragraph('Audience Breakdown', styles['heading1']))
    if narratives.get('audience_breakdown'):
        elements.append(Paragraph(narratives['audience_breakdown'], styles['body']))
    if 'languageBars' in charts:
        elements.append(Paragraph('Language Distribution', styles['heading2']))
        add_chart(elements, charts['languageBars'])
    if 'regionBars' in charts:
        elements.append(Paragraph('Region Distribution', styles['heading2']))
        add_chart(elements, charts['regionBars'])

    # ── Channel Performance ──
    elements.append(Paragraph('Channel Performance', styles['heading1']))
    if 'channelLeaderboard' in charts:
        add_chart(elements, charts['channelLeaderboard'])

    leaderboard = agg.get('channelLeaderboard', [])[:20]
    if leaderboard:
        lb_rows = [
            [str(i + 1), ch.get('displayName', ''),
             platform_label(ch.get('platform', '')),
             format_number(ch.get('peakCCV', 0)),
             format_number(ch.get('avgCCV', 0))]
            for i, ch in enumerate(leaderboard)
        ]
        tbl = make_table(['#', 'Channel', 'Platform', 'Peak CCV', 'Avg CCV'], lb_rows, branding)
        elements.append(tbl)
        elements.append(Spacer(1, 16))

    # ── Community Reach ──
    if narratives.get('community_reach'):
        elements.append(Paragraph('Community Reach', styles['heading1']))
        elements.append(Paragraph(narratives['community_reach'], styles['body']))
        elements.append(Spacer(1, 12))

    # ── Day-over-Day (stage/series) ──
    if scope in ('stage', 'series', 'multi_stage') and 'dayOverDay' in charts:
        elements.append(Paragraph('Day-over-Day Trend', styles['heading1']))
        if narratives.get('day_over_day'):
            elements.append(Paragraph(narratives['day_over_day'], styles['body']))
        add_chart(elements, charts['dayOverDay'])

    # ── Stage Comparison (series) ──
    if scope == 'series' and 'stageComparison' in charts:
        elements.append(Paragraph('Stage Comparison', styles['heading1']))
        if narratives.get('stage_comparison'):
            elements.append(Paragraph(narratives['stage_comparison'], styles['body']))
        add_chart(elements, charts['stageComparison'])

    # ── VOD Metrics ──
    if narratives.get('vod_metrics'):
        elements.append(Paragraph('VOD & Clip Performance', styles['heading1']))
        elements.append(Paragraph(narratives['vod_metrics'], styles['body']))

    # ── Historical Comparison ──
    if narratives.get('historical_comparison'):
        elements.append(Paragraph('Historical Comparison', styles['heading1']))
        elements.append(Paragraph(narratives['historical_comparison'], styles['body']))

    # ── Methodology ──
    elements.append(Paragraph('Methodology', styles['heading1']))
    snap_count = payload.get('snapshotCount', 0)
    meth_text = (
        f"This report was generated from {format_number(snap_count)} viewership snapshots "
        f"collected across {len(channels)} tracked channels. Data is captured at regular "
        f"polling intervals during live broadcasts via platform APIs. "
        f"Report scope: {scope}."
    )
    elements.append(Paragraph(meth_text, styles['body_muted']))

    # Build PDF
    doc.build(elements, onFirstPage=on_page, onLaterPages=on_page)
    print(json.dumps({'status': 'ok', 'path': output_path}))


def main():
    input_data = read_stdin_json()
    build_pdf(input_data)


if __name__ == '__main__':
    main()
