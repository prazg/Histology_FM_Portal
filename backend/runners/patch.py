"""Patch-encoder tasks (any TRIDENT encoder, plus PLIP / QuiltNet via the zero-shot adapters)."""
from __future__ import annotations

import numpy as np

from .common import (MockImageEncoder, autocast, batched, kmeans, load_tiles, pca, prepare_slide,
                     save_thumbs, slide_features, unit_rgb)

CLUSTER_COLOURS = 12


def mock_dim(model) -> int:
    d = model.get("embed_dim")
    return int(str(d).split("/")[0].strip()) if d else 512


def load_encoder(ctx, name: str, **kw):
    """TRIDENT patch encoder (handles HF download, transforms and precision)."""
    from trident.patch_encoder_models import encoder_factory
    ctx.progress(0.02, f"Loading {name} via TRIDENT encoder_factory")
    enc = encoder_factory(name, **kw)
    return enc.eval().to(ctx.device)


def encode_tiles(ctx, enc, imgs, bs: int = 64) -> np.ndarray:
    import torch
    out = []
    for i, chunk in batched(imgs, bs):
        x = torch.stack([enc.eval_transforms(im) for im in chunk]).to(ctx.device)
        with torch.inference_mode(), autocast(ctx, enc.precision):
            out.append(enc(x).float().cpu().numpy())
        ctx.progress(0.1 + 0.7 * (i + len(chunk)) / len(imgs))
    return np.concatenate(out)


def _get_encoder(ctx):
    """Returns (callable on PIL list → N×D, trident-compatible encoder or None, name)."""
    m = ctx.model
    if m.get("runner") == "custom_vl":
        from .zeroshot import get_adapter
        ad = get_adapter(ctx)
        return ad.encode_images, ad.trident_encoder(), m["id"]
    if ctx.mock:
        e = MockImageEncoder(m["id"], mock_dim(m))
        return e, None, m["id"]
    enc = load_encoder(ctx, m["trident_name"])
    return (lambda imgs: encode_tiles(ctx, enc, imgs)), enc, m["trident_name"]


def _write_h5(path, feats, names=None, coords=None, attrs=None):
    import h5py
    with h5py.File(path, "w") as f:
        f.create_dataset("features", data=feats.astype(np.float32), compression="gzip")
        if coords is not None:
            ds = f.create_dataset("coords", data=np.asarray(coords))
            for k, v in (attrs or {}).items():
                ds.attrs[k] = v
        if names is not None:
            f.create_dataset("names", data=np.array(names, dtype="S"))


def run_embed_tiles(ctx) -> dict:
    names, imgs = load_tiles(ctx.inputs["tiles"])
    encode, _, enc_name = _get_encoder(ctx)
    ctx.progress(0.1, f"Embedding {len(imgs)} tiles")
    feats = encode(imgs)
    k = int(ctx.params.get("k", min(6, max(2, len(imgs) // 3))))
    labels = kmeans(feats, k) if len(imgs) >= 2 else np.zeros(len(imgs), int)
    scores, ratio = pca(feats, 2)
    thumbs = save_thumbs(ctx, names, imgs)
    _write_h5(ctx.out_path("embeddings.h5"), feats, names=names)
    ctx.register("embeddings.h5", f"Embeddings {feats.shape[0]}×{feats.shape[1]} (h5: features, names)")
    np.savetxt(ctx.out_path("embeddings.csv"), feats, delimiter=",", fmt="%.6g")
    ctx.register("embeddings.csv", "Embeddings as CSV (row order = tile order)")

    panels = [{"type": "scatter", "title": f"PCA of {enc_name} embeddings",
               "x": scores[:, 0].round(4).tolist(), "y": scores[:, 1].round(4).tolist(),
               "group": labels.tolist(), "names": names, "thumbs": thumbs,
               "xlabel": f"PC1 ({ratio[0]*100:.1f}% var)", "ylabel": f"PC2 ({ratio[1]*100:.1f}% var)",
               "legend": [f"Cluster {i+1}" for i in range(int(labels.max()) + 1)]}]
    if len(imgs) <= 300:
        from .common import l2n
        f = l2n(feats)
        sim = f @ f.T
        order = np.argsort(labels, kind="stable")
        panels.append({"type": "matrix", "title": "Cosine similarity (rows grouped by cluster)",
                       "rows": [names[i] for i in order], "cols": [names[i] for i in order],
                       "values": sim[np.ix_(order, order)].round(3).tolist(), "vmin": float(sim.min()), "vmax": 1.0})
    panels.append({"type": "table", "title": "Cluster assignment", "columns": ["Tile", "Cluster", "PC1", "PC2"],
                   "rows": [[n, int(l) + 1, round(float(a), 3), round(float(b), 3)]
                            for n, l, a, b in zip(names, labels, scores[:, 0], scores[:, 1])]})
    return {"summary": [{"label": "Tiles", "value": len(imgs)}, {"label": "Embedding dim", "value": int(feats.shape[1])},
                        {"label": "Clusters (k-means, cosine)", "value": int(labels.max()) + 1}],
            "panels": panels}


def run_embed_wsi(ctx) -> dict:
    m = ctx.model
    mag = int(ctx.params.get("mag", m["mag"]))
    ps = int(ctx.params.get("patch_size", m["patch_size"]))
    sp = prepare_slide(ctx, mag, ps, max_patches=int(ctx.params.get("max_patches", 0)) or None)
    encode, trident_enc, enc_name = _get_encoder(ctx)
    if ctx.mock:
        from .common import read_patches
        feats = np.concatenate([encode(read_patches(sp, chunk, ps)) for _, chunk in batched(list(range(len(sp.coords))), 64)])
        h5src = None
    else:
        feats, h5src = slide_features(ctx, sp, trident_enc, enc_name, 0, ps)
    ctx.progress(0.85, "Clustering and projecting")
    k = int(ctx.params.get("k", 8))
    labels = kmeans(feats, k)
    scores, ratio = pca(feats, 3)
    rgb = unit_rgb(scores)

    if h5src:
        ctx.out_path("patch_features.h5").write_bytes(open(h5src, "rb").read())
    else:
        _write_h5(ctx.out_path("patch_features.h5"), feats, coords=sp.coords, attrs={"patch_size_level0": sp.patch0})
    ctx.register("patch_features.h5", f"Patch features {feats.shape[0]}×{feats.shape[1]} (TRIDENT h5: features, coords)")

    vals = np.column_stack([labels, rgb, scores])
    chans = [{"name": "k-means cluster", "kind": "categorical", "labels": [f"Cluster {i+1}" for i in range(k)]},
             {"name": "PC1 (red)", "kind": "continuous"}, {"name": "PC2 (green)", "kind": "continuous"},
             {"name": "PC3 (blue)", "kind": "continuous"},
             {"name": f"PC1 raw ({ratio[0]*100:.1f}% var)", "kind": "continuous"},
             {"name": f"PC2 raw ({ratio[1]*100:.1f}% var)", "kind": "continuous"},
             {"name": f"PC3 raw ({ratio[2]*100:.1f}% var)", "kind": "continuous"}]
    panels = [ctx.spatial_panel("embed", f"{m['name']} patch embeddings on the slide", sp.coords, sp.patch0, vals,
                                chans, sp.thumb, sp.scale, rgb=[1, 2, 3])]
    counts = np.bincount(labels, minlength=k)
    panels.append({"type": "bars", "title": "Patches per cluster", "labels": [f"Cluster {i+1}" for i in range(k)],
                   "rows": ["Patches"], "values": [counts.tolist()], "categorical": True})
    if sp.contours:
        panels.append({"type": "image", "title": "Tissue segmentation (TRIDENT)", "src": sp.contours})
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Patches", "value": int(len(feats))},
                        {"label": "Patch", "value": f"{ps} px @ {mag}x"},
                        {"label": "Embedding dim", "value": int(feats.shape[1])}],
            "panels": panels}
