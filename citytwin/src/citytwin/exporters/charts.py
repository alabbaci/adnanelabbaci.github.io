"""Static SVG charts written straight from the metrics — no plotting dependency.

Keeping the figures in SVG means they render identically in the README, in
GitHub's viewer and in a PDF, and they stay editable in a text editor.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

INK = "#1c1f23"
MUTED = "#6a7076"
GRID = "#e4e2db"
RULE = "#1f4e79"
MODEL = "#c26a33"
FONT = "-apple-system,'Helvetica Neue',Inter,Segoe UI,Roboto,sans-serif"


def benchmark_chart(benchmark: dict[str, Any], path: Path) -> Path:
    """Horizontal bars: blocked MAE of the shipped rule vs the learned model."""
    rule = benchmark["rule"]["metrics"]
    model = benchmark["model"]["metrics"]
    random_folds = benchmark["model"]["random_fold_metrics"]

    rows = [
        ("rule · class median (shipped)", rule["mae"], RULE),
        ("random forest · blocked CV", model["mae"], MODEL),
        ("random forest · random CV (reference)", random_folds["mae"], "#a9a49a"),
    ]
    width, height = 720, 260
    left, right, top = 260, 60, 54
    plot_w = width - left - right
    max_mae = max(r[1] for r in rows) * 1.15
    bar_h = 26
    gap = 26

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="{FONT}">',
        f'<rect width="{width}" height="{height}" fill="#fbfaf7"/>',
        f'<text x="24" y="30" font-size="15" font-weight="650" fill="{INK}">'
        "Height completion — blocked cross-validation</text>",
        f'<text x="24" y="47" font-size="11" fill="{MUTED}">'
        f"{benchmark['model']['n_labelled']} labels, 5 folds of 300 m spatial blocks · MAE in metres</text>",
    ]

    for tick in range(0, 5):
        value = max_mae * tick / 4
        x = left + plot_w * tick / 4
        parts.append(
            f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{height - 34}" stroke="{GRID}" stroke-width="1"/>'
        )
        parts.append(
            f'<text x="{x:.1f}" y="{height - 18}" font-size="10" fill="{MUTED}" text-anchor="middle">'
            f"{value:.1f}</text>"
        )

    for index, (label, value, colour) in enumerate(rows):
        y = top + index * (bar_h + gap)
        bar_w = plot_w * value / max_mae
        parts.append(
            f'<text x="{left - 12}" y="{y + bar_h * 0.63:.1f}" font-size="11.5" fill="{INK}" text-anchor="end">'
            f"{label}</text>"
        )
        parts.append(
            f'<rect x="{left}" y="{y}" width="{bar_w:.1f}" height="{bar_h}" rx="3" fill="{colour}"/>'
        )
        parts.append(
            f'<text x="{left + bar_w + 8:.1f}" y="{y + bar_h * 0.63:.1f}" font-size="11" font-weight="600" '
            f'fill="{INK}">{value:.2f} m</text>'
        )

    delta = benchmark["delta_mae_m"]
    verdict = "learned model wins" if delta < 0 else "learned model does not beat the rule"
    parts.append(
        f'<text x="24" y="{height - 2}" font-size="10" fill="{MUTED}">'
        f"Δ MAE {delta:+.2f} m → {verdict}; the explainable rule is shipped by default."
        "</text>"
    )
    parts.append("</svg>")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts), encoding="utf-8")
    return path
