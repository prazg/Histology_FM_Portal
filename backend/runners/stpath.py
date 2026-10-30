"""STPath — spatial gene expression from H&E (Graph-and-Geometric-Learning/STPath, HF tlhuang/STPath).

Spot grid → GigaPath tile embeddings (timm hf_hub:prov-gigapath/prov-gigapath, Resize 256 → CenterCrop 224,
ImageNet norm, as in the GigaPath README) → STPathInference(gene_voc_path, model_weight_path, device).inference(...)
per the STPath model card. Predicted values are log1p expression."""
from __future__ import annotations

import json
import sys

import numpy as np
from PIL import Image

from .common import MockImageEncoder, batched, prepare_slide

DEFAULT_GENES = ["GFAP", "SOX2", "OLIG2", "EGFR", "CD44", "CHI3L1", "VIM", "MKI67", "PTPRC", "CD68", "CD163",
                 "AIF1", "CD3E", "CD8A", "PECAM1", "VEGFA", "COL1A1", "COL4A1", "FN1", "POSTN"]


def _spots(ctx, sp, spot_um):
    """Spot centres = patch centres of a TRIDENT grid whose pitch is the spot pitch."""
    centres = sp.coords + sp.patch0 / 2.0
    mpp = sp.mpp or 0.5
    side0 = int(round(spot_um / mpp))
    return centres, side0


def _gigapath_feats(ctx, sp, centres, side0):
    imgs_at = lambda idx: [sp.slide.read_region((int(centres[i][0] - side0 / 2), int(centres[i][1] - side0 / 2)), 0,
                                                (side0, side0)).convert("RGB").resize((224, 224), Image.BICUBIC) for i in idx]
    n = len(centres)
    if ctx.mock:
        enc = MockImageEncoder("gigapath", 1536)
        return np.concatenate([enc(imgs_at(ch)) for _, ch in batched(list(range(n)), 64)])
    import timm
    import torch
    from torchvision import transforms
    ctx.progress(0.25, "Loading Prov-GigaPath tile encoder")
    model = timm.create_model("hf_hub:prov-gigapath/prov-gigapath", pretrained=True).eval().to(ctx.device)
    tf = transforms.Compose([transforms.Resize(256, interpolation=transforms.InterpolationMode.BICUBIC),
                             transforms.CenterCrop(224), transforms.ToTensor(),
                             transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
    out = []
    for i, ch in batched(list(range(n)), 64):
        x = torch.stack([tf(im) for im in imgs_at(ch)]).to(ctx.device)
        with torch.inference_mode():
            out.append(model(x).float().cpu().numpy())
        ctx.progress(0.25 + 0.5 * (i + len(ch)) / n)
    return np.concatenate(out)


def run_st_wsi(ctx) -> dict:
    p = ctx.params
    pitch_um = float(p.get("pitch_um", 100.0))
    spot_um = float(p.get("spot_um", 55.0))
    mag = 20
    sp = prepare_slide(ctx, mag, int(round(pitch_um / 0.5)), min_tissue=float(p.get("min_tissue", 0.6)),
                       max_patches=int(p.get("max_spots", 3000)) or None)
    centres, side0 = _spots(ctx, sp, spot_um)
    ctx.log(f"{len(centres)} spots · pitch {pitch_um} µm · spot {spot_um} µm ({side0} level-0 px)")
    feats = _gigapath_feats(ctx, sp, centres, side0)
    genes = [g.strip() for g in (p.get("genes") or ",".join(DEFAULT_GENES)).replace("\n", ",").split(",") if g.strip()]
    organ = p.get("organ") or None
    tech = p.get("tech") or None

    if ctx.mock:
        rng = np.random.default_rng(7)
        W = rng.standard_normal((feats.shape[1], len(genes))) / 40
        X = np.log1p(np.exp(feats @ W))
        found = genes
    else:
        repo = ctx.settings.stpath_repo
        if not repo or not (repo / "utils_data" / "symbol2ensembl.json").exists():
            raise RuntimeError("Set stpath_repo in backend/config.yaml to a clone of Graph-and-Geometric-Learning/STPath")
        sys.path.insert(0, str(repo))
        import torch
        weights = ctx.settings.stpath_weights
        if not weights:
            from huggingface_hub import hf_hub_download
            weights = hf_hub_download("tlhuang/STPath", "stfm.pth")
        if not ctx.device.startswith("cuda"):  # weights were saved on CUDA
            _load = torch.load
            torch.load = lambda *a, **k: _load(*a, **{**k, "map_location": "cpu"})
        from stpath.app.pipeline.inference import STPathInference
        sym2ens = json.loads((repo / "utils_data" / "symbol2ensembl.json").read_text())
        ctx.progress(0.8, f"STPath inference (organ={organ}, tech={tech})")
        agent = STPathInference(gene_voc_path=str(repo / "utils_data" / "symbol2ensembl.json"),
                                model_weight_path=str(weights), device=0 if ctx.device.startswith("cuda") else "cpu")
        ad = agent.inference(coords=centres.astype(np.float32).copy(), img_features=feats, organ_type=organ, tech_type=tech)
        ad.write_h5ad(ctx.out_path("stpath_pred.h5ad"))
        ctx.register("stpath_pred.h5ad", f"AnnData {ad.n_obs} spots × {ad.n_vars} genes (log1p)")
        var = list(map(str, ad.var_names))
        cols, found = [], []
        for g in genes:
            key = g if g in var else sym2ens.get(g)
            key = key[0] if isinstance(key, list) else key
            if key in var:
                cols.append(var.index(key))
                found.append(g)
            else:
                ctx.log(f"Gene {g} not in STPath vocabulary — skipped")
        Xa = ad.X[:, cols]
        X = np.asarray(Xa.toarray() if hasattr(Xa, "toarray") else Xa, dtype=np.float32)
    np.savetxt(ctx.out_path("stpath_selected_genes.csv"), np.column_stack([centres, X]), delimiter=",",
               header="x,y," + ",".join(found), comments="", fmt="%.5g")
    ctx.register("stpath_selected_genes.csv", "Selected genes per spot (log1p), spot-centre coordinates")
    chans = [{"name": g, "kind": "continuous"} for g in found]
    rows = sorted([[g, round(float(X[:, i].mean()), 4), round(float(X[:, i].std()), 4)] for i, g in enumerate(found)], key=lambda r: -r[2])
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Spots", "value": len(centres)},
                        {"label": "Genes shown", "value": len(found)}, {"label": "Organ / tech", "value": f"{organ or '—'} / {tech or '—'}"}],
            "panels": [ctx.spatial_panel("st", "STPath predicted expression (log1p)", sp.coords, sp.patch0, X, chans, sp.thumb, sp.scale),
                       {"type": "table", "title": "Genes ranked by spatial variability", "columns": ["Gene", "Mean log1p", "SD"], "rows": rows}]}
