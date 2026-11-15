"""Tissue segmentation via TRIDENT (hest / grandqc / otsu) and TiSAM (MegaMouse mouse anatomy)."""
from __future__ import annotations

import csv
import sys
import numpy as np
from PIL import Image

from .common import MockSlide

MEGAMOUSE_CLASSES = [
    ("Hepatic parenchyma / cortex", (78, 121, 167, 135)),
    ("Portal triad / vasculature", (225, 87, 89, 145)),
    ("Biliary / tubular epithelium", (89, 161, 79, 140)),
    ("Connective stroma / capsule", (242, 142, 43, 135)),
]


def _run_tisam(ctx) -> dict:
    if ctx.mock:
        slide = MockSlide(ctx.inputs["wsi"], float(ctx.params.get("mpp") or 0.5))
        mask, _ = slide.tissue_mask()
        thumb = slide.get_thumbnail((1024, 1024)).convert("RGB")
        w, h = thumb.size
        m_arr = np.array(Image.fromarray((mask * 255).astype(np.uint8)).resize((w, h))) > 127
        yy, xx = np.mgrid[0:h, 0:w]
        wave = (np.sin(xx / 45.0) + np.cos(yy / 38.0) + 2.0) / 4.0
        comp = np.floor(wave * len(MEGAMOUSE_CLASSES)).astype(int).clip(0, len(MEGAMOUSE_CLASSES) - 1)
        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ov = np.zeros((h, w, 4), dtype=np.uint8)
        rows = []
        tot = max(int(m_arr.sum()), 1)
        for idx, (cname, rgba) in enumerate(MEGAMOUSE_CLASSES):
            sel = m_arr & (comp == idx)
            ov[sel] = rgba
            rows.append([cname, int(sel.sum()), f"{sel.sum() / tot * 100:.1f}%"])
        overlay = Image.fromarray(ov, mode="RGBA")
        Image.alpha_composite(thumb.convert("RGBA"), overlay).convert("RGB").save(ctx.out_path("contours.jpg"))
        frac = float(m_arr.mean())
    else:
        repo = ctx.settings.tisam_repo
        if not repo or not repo.exists():
            raise RuntimeError("Set tisam_repo in backend/config.yaml to a clone of Kiemen-Lab/tisam")
        sys.path.insert(0, str(repo))
        ctx.progress(0.15, "Running TiSAM (MegaMouse 52-class mouse segmentation)")
        from tisam.infer import segment_wsi_megamouse  # type: ignore
        out = segment_wsi_megamouse(wsi_path=str(ctx.inputs["wsi"]), out_dir=str(ctx.scratch), device=ctx.device)
        ctx.out_path("contours.jpg").write_bytes(out["overlay_jpg"].read_bytes())
        if out.get("geojson") and out["geojson"].exists():
            ctx.out_path("megamouse.geojson").write_bytes(out["geojson"].read_bytes())
            ctx.register("megamouse.geojson", "MegaMouse multi-class mouse contours (GeoJSON — opens in QuPath)")
        rows = out.get("compartment_rows", [])
        frac = None

    ctx.register("contours.jpg", "TiSAM MegaMouse anatomical overlay")
    with open(ctx.out_path("megamouse_compartments.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["compartment", "pixels", "tissue_share"])
        w.writerows(rows)
    ctx.register("megamouse_compartments.csv", "Compartment area breakdown (CSV)")

    s = [{"label": "Segmenter", "value": "TiSAM (MegaMouse)"},
         {"label": "Mouse compartments", "value": len(rows)}]
    if frac is not None:
        s.append({"label": "Tissue fraction (mock)", "value": f"{frac * 100:.1f}%"})
    return {
        "summary": s,
        "panels": [
            {"type": "image", "title": "TiSAM (MegaMouse) multi-compartment segmentation", "src": "contours.jpg"},
            {"type": "table", "title": "Segmented mouse tissue compartments", "columns": ["Compartment", "Area (px)", "% of tissue"], "rows": rows},
        ],
    }


def run_segment_wsi(ctx) -> dict:
    if ctx.model.get("runner") == "tisam":
        return _run_tisam(ctx)
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
