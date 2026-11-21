"""Project configuration: study area, coordinate systems, grid and index weights.

Everything that a reviewer might want to change lives here or in
``configs/exposure_weights.json``; nothing is hard-coded in the pipeline.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Repository layout
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
BUILD_DIR = REPO_ROOT / "build"
DOCS_ASSETS = REPO_ROOT / "docs" / "assets"
#: The published viewer is written to the project root so GitHub Pages serves it
#: at ``/citytwin/``; its template lives in ``web/``.
WEB_DIR = REPO_ROOT
CONFIG_DIR = REPO_ROOT / "configs"


# ---------------------------------------------------------------------------
# Coordinate reference systems
# ---------------------------------------------------------------------------
#: Storage / exchange CRS (GeoJSON, OGC API, CityJSON).
CRS_GEOGRAPHIC = "EPSG:4326"
#: Metric CRS for the Dakhla study area (WGS 84 / UTM zone 28N).
CRS_METRIC = "EPSG:32628"
#: Equal-area CRS used for geodetic area checks (WGS 84 / NSIDC EASE-Grid 2.0 Global).
CRS_EQUAL_AREA = "EPSG:6933"
#: Geocentric CRS used by 3D Tiles / glTF content.
CRS_ECEF = "EPSG:4978"


@dataclass(frozen=True)
class AOI:
    """Area of interest, expressed in WGS84 degrees."""

    name: str
    slug: str
    #: (min_lon, min_lat, max_lon, max_lat)
    bbox: tuple[float, float, float, float]
    description: str = ""

    @property
    def bbox_metric(self) -> tuple[float, float, float, float]:
        from pyproj import Transformer

        t = Transformer.from_crs(CRS_GEOGRAPHIC, CRS_METRIC, always_xy=True)
        x0, y0 = t.transform(self.bbox[0], self.bbox[1])
        x1, y1 = t.transform(self.bbox[2], self.bbox[3])
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    @property
    def bbox_str(self) -> str:
        """``minlon,minlat,maxlon,maxlat`` as a compact string."""
        return ",".join(f"{v:.6f}" for v in self.bbox)


#: Default study area: the city of Dakhla on the Río de Oro peninsula.
#: The box is 5.0 km x 6.5 km, aligned to the 250 m UTM 28N grid
#: (E 401 500-406 500, N 2 619 000-2 625 500).
DAKHLA = AOI(
    name="Dakhla",
    slug="dakhla",
    bbox=(-15.966016, 23.678805, -15.917395, 23.737807),
    description=(
        "The city of Dakhla (Dakhla-Oued Ed-Dahab): a low-rise Atlantic port city on a "
        "narrow desert peninsula between the ocean and the Dakhla lagoon."
    ),
)

AOIS: dict[str, AOI] = {DAKHLA.slug: DAKHLA}
DEFAULT_AOI = DAKHLA

#: Overture Maps release the twin is built from (override with CITYTWIN_OVERTURE_RELEASE).
OVERTURE_RELEASE = os.environ.get("CITYTWIN_OVERTURE_RELEASE", "2026-11-18.0")

#: Analysis grid edge length in metres.
GRID_SIZE_M = 250.0
#: Edge length of the blocks used for spatially blocked cross-validation.
CV_BLOCK_SIZE_M = 300.0
#: Assumed storey height when only ``building:levels`` is mapped.
STOREY_HEIGHT_M = 3.0
#: Sketch-engine default when neither height nor levels is mapped.
DEFAULT_HEIGHT_M = 6.0
#: Floor of the half-width of the imputed-height interval. Floor counts are whole
#: storeys, so a conformal quantile computed on them can collapse to zero when one
#: storey count dominates the labels; an imputed height is never known to better
#: than one storey.
MIN_INTERVAL_M = STOREY_HEIGHT_M


@dataclass(frozen=True)
class ExposureWeights:
    """Weights of the four normalised components of the Heat Exposure Index.

    The index is deliberately transparent: a weighted sum over percentile-ranked
    components, so that every cell's score can be decomposed and explained.
    """

    building_height: float = 0.15
    lack_of_green: float = 0.30
    distance_to_green: float = 0.20
    built_up_share: float = 0.35

    def __post_init__(self) -> None:
        total = (
            self.building_height + self.lack_of_green + self.distance_to_green + self.built_up_share
        )
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"weights must sum to 1.0, got {total:.3f}")

    def as_dict(self) -> dict[str, float]:
        return asdict(self)


DEFAULT_WEIGHTS = ExposureWeights()


def load_weights(path: Path | None = None) -> ExposureWeights:
    """Load index weights from JSON, falling back to the documented defaults."""
    path = path or (CONFIG_DIR / "exposure_weights.json")
    if not path.exists():
        return DEFAULT_WEIGHTS
    raw = json.loads(path.read_text(encoding="utf-8"))
    return ExposureWeights(**raw)


def aoi_from_slug(slug: str | None) -> AOI:
    if slug is None:
        return DEFAULT_AOI
    try:
        return AOIS[slug]
    except KeyError as exc:  # pragma: no cover - user input guard
        raise KeyError(f"unknown AOI {slug!r}; available: {sorted(AOIS)}") from exc
