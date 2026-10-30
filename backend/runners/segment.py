"""Tissue segmentation via TRIDENT (hest / grandqc / otsu)."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .common import MockSlide


def run_segment_wsi(ctx) -> dict:
    name = ctx.model["trident_name"]
    if ctx.mock:
        slide = MockSlide(ctx.inputs["wsi"], float(ctx.params.get("mpp") or 0.5))
        mask, _ = slide.tissue_mask()
        thumb = slide.get_thumbnail((1024, 1024)).convert("RGB")
        overlay = Image.new("RGBA", thumb.size, (0, 0, 0, 0))
        m = Image.fromarray((mask * 120).astype(np.uint8)).resize(thumb.size)
        overlay.paste((40, 170, 120, 255), mask=m)
        Image.alpha_composite(thumb.convert("RGBA"), overlay).convert("RGB").save(ctx.out_path("contours.jpg"))
        frac = float(mask.mean())
        n_regions = "—"
    else:
        from pathlib import Path
        from trident import load_wsi
        from trident.segmentation_models import segmentation_model_factory
        kw = {"mpp": float(ctx.params["mpp"])} if ctx.params.get("mpp") else {}
        slide = load_wsi(slide_path=ctx.inputs["wsi"], lazy_init=False, **kw)
        ctx.progress(0.1, f"Segmenting with {name}")
        gj = slide.segment_tissue(segmentation_model=segmentation_model_factory(name), target_mag=10,
                                  job_dir=str(ctx.scratch), device=ctx.device)
        ctx.out_path("contours.jpg").write_bytes((ctx.scratch / "contours" / f"{slide.name}.jpg").read_bytes())
        ctx.out_path("tissue.geojson").write_bytes(Path(gj).read_bytes())
        ctx.register("tissue.geojson", "Tissue contours (GeoJSON, level-0 px) — opens in QuPath")
        n_regions = int(len(slide.gdf_contours))
        frac = None
    ctx.register("contours.jpg", "Contour overlay")
    s = [{"label": "Segmenter", "value": name}, {"label": "Tissue regions", "value": n_regions}]
    if frac is not None:
        s.append({"label": "Tissue fraction (mock threshold)", "value": f"{frac*100:.1f}%"})
    return {"summary": s, "panels": [{"type": "image", "title": "Tissue segmentation", "src": "contours.jpg"}]}
