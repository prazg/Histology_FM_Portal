"""GigaTIME virtual mIF (23 channels). Follows the official gigatime_testing notebook:
archs.gigatime(num_classes=23, input_channels=3); model.pth from HF prov-gigatime/GigaTIME;
ImageNet mean/std (HF config.json pretrained_cfg); 512 px input run as 256 px windows; sigmoid on logits."""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image

from .common import batched, load_tiles, prepare_slide, read_patches, save_thumbs, to_png

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
IN_PX, WIN = 512, 256
_model = {}


def _load(ctx):
    if "m" in _model:
        return _model["m"]
    import torch
    from huggingface_hub import snapshot_download
    repo = ctx.settings.gigatime_repo
    if not repo or not (repo / "scripts" / "archs.py").exists():
        raise RuntimeError("Set gigatime_repo in backend/config.yaml to a clone of github.com/prov-gigatime/GigaTIME")
    sys.path.insert(0, str(repo / "scripts"))
    import archs
    ctx.progress(0.03, "Downloading/loading GigaTIME weights (prov-gigatime/GigaTIME)")
    model = archs.gigatime(num_classes=23, input_channels=3)
    sd = torch.load(f"{snapshot_download(repo_id='prov-gigatime/GigaTIME')}/model.pth", map_location="cpu")
    model.load_state_dict(sd)
    _model["m"] = model.eval().to(ctx.device)
    return _model["m"]


def _mock_probs(imgs, n_ch):
    out = []
    for im in imgs:
        a = np.asarray(im.resize((IN_PX, IN_PX)), np.float32) / 255.0
        h = 1 - a[..., 2] * 0.6 - a[..., 1] * 0.4          # crude "haematoxylin-ness"
        e = a[..., 0] - a[..., 1]                           # crude "eosin-ness"
        chans = [np.clip((h if c % 2 else e) * (0.6 + 0.4 * np.sin(c)) + 0.2, 0, 1) for c in range(n_ch)]
        out.append(np.stack(chans))
    return np.stack(out).astype(np.float32)


def infer(ctx, imgs) -> np.ndarray:
    """→ probabilities [N, 23, 512, 512]."""
    n_ch = len(ctx.model["channels"])
    if ctx.mock:
        return _mock_probs(imgs, n_ch)
    import torch
    model = _load(ctx)
    probs = []
    for _, chunk in batched(imgs, 8):
        x = np.stack([(np.asarray(im.convert("RGB").resize((IN_PX, IN_PX), Image.BILINEAR), np.float32) / 255.0 - MEAN) / STD
                      for im in chunk]).transpose(0, 3, 1, 2)
        x = torch.from_numpy(x).to(ctx.device)
        logits = torch.zeros(x.shape[0], n_ch, IN_PX, IN_PX, device=ctx.device)
        with torch.no_grad():
            for i in range(0, IN_PX, WIN):
                for j in range(0, IN_PX, WIN):
                    logits[:, :, i:i + WIN, j:j + WIN] = model(x[:, :, i:i + WIN, j:j + WIN])
        probs.append(torch.sigmoid(logits).cpu().numpy())
    return np.concatenate(probs)


def _marker_idx(ctx):
    bg = set(ctx.model.get("background_channels", []))
    return [i for i, c in enumerate(ctx.model["channels"]) if c not in bg]


def run_vmif_tiles(ctx) -> dict:
    names, imgs = load_tiles(ctx.inputs["tiles"])
    ch = ctx.model["channels"]
    keep = _marker_idx(ctx)
    ctx.progress(0.1, f"GigaTIME on {len(imgs)} tiles")
    P = infer(ctx, imgs)
    means = P.mean(axis=(2, 3))                                   # N × 23
    thumbs = save_thumbs(ctx, names, imgs)
    max_maps = int(ctx.params.get("max_tile_maps", 12))
    tiles = []
    for t in range(min(len(imgs), max_maps)):
        imgs_t = []
        for c in keep:
            fn = f"vmif_{t:04d}_{c:02d}.png"
            to_png(P[t, c], ctx.out_path(fn), 0, 1, size=256)
            imgs_t.append({"name": ch[c], "src": fn, "mean": round(float(means[t, c]), 4)})
        tiles.append({"name": names[t], "thumb": thumbs[t], "images": imgs_t})
    np.save(ctx.out_path("vmif_probs.npy"), P.astype(np.float16))
    ctx.register("vmif_probs.npy", "Probability maps float16 [N, 23, 512, 512] — channel order in channels.txt")
    ctx.out_path("channels.txt").write_text("\n".join(ch))
    ctx.register("channels.txt", "Channel order")
    np.savetxt(ctx.out_path("vmif_means.csv"), means, delimiter=",", header=",".join(ch), comments="", fmt="%.5f")
    ctx.register("vmif_means.csv", "Mean probability per tile × channel")
    return {"summary": [{"label": "Tiles", "value": len(imgs)}, {"label": "Marker channels", "value": len(keep)},
                        {"label": "Background channels hidden", "value": ", ".join(ctx.model.get("background_channels", []))}],
            "panels": [{"type": "channels", "title": "Virtual mIF maps", "tiles": tiles},
                       {"type": "matrix", "title": "Mean marker probability (tiles × markers)", "rows": names,
                        "cols": [ch[c] for c in keep], "values": means[:, keep].round(4).tolist(),
                        "vmin": 0.0, "vmax": float(max(1e-3, means[:, keep].max()))}]}


def run_vmif_wsi(ctx) -> dict:
    ch = ctx.model["channels"]
    keep = _marker_idx(ctx)
    mag = int(ctx.params.get("mag", ctx.model["mag"]))
    sp = prepare_slide(ctx, mag, IN_PX, max_patches=int(ctx.params.get("max_patches", 3000)) or None)
    n = len(sp.coords)
    means = np.zeros((n, len(ch)), np.float32)
    pos = np.zeros((n, len(ch)), np.float32)
    for i, idx in batched(list(range(n)), 16):
        P = infer(ctx, read_patches(sp, idx, IN_PX))
        means[i:i + len(idx)] = P.mean(axis=(2, 3))
        pos[i:i + len(idx)] = (P > 0.5).mean(axis=(2, 3))
        ctx.progress(0.2 + 0.7 * (i + len(idx)) / n, None)
    hdr = "x,y," + ",".join(ch)
    np.savetxt(ctx.out_path("vmif_patch_means.csv"), np.column_stack([sp.coords, means]), delimiter=",", header=hdr, comments="", fmt="%.5g")
    ctx.register("vmif_patch_means.csv", "Mean probability per patch × channel (level-0 coords)")
    np.savetxt(ctx.out_path("vmif_patch_positive_fraction.csv"), np.column_stack([sp.coords, pos]), delimiter=",", header=hdr, comments="", fmt="%.5g")
    ctx.register("vmif_patch_positive_fraction.csv", "Fraction of pixels with p > 0.5 per patch × channel")
    chans = [{"name": f"{ch[c]} (mean p)", "kind": "continuous"} for c in keep] + \
            [{"name": f"{ch[c]} (% px > 0.5)", "kind": "continuous"} for c in keep]
    vals = np.column_stack([means[:, keep], pos[:, keep]])
    rows = [[ch[c], round(float(means[:, c].mean()), 4), round(float(means[:, c].std()), 4), round(float(pos[:, c].mean()), 4)] for c in keep]
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Patches (512 px)", "value": n},
                        {"label": "Magnification", "value": f"{mag}x"}],
            "panels": [ctx.spatial_panel("vmif", "GigaTIME virtual mIF", sp.coords, sp.patch0, vals, chans, sp.thumb, sp.scale),
                       {"type": "table", "title": "Slide summary", "columns": ["Marker", "Mean p", "SD across patches", "Mean % px > 0.5"], "rows": rows},
                       {"type": "note", "tone": "warn", "text": "20x is the portal default, not a documented requirement — confirm against the GigaTIME paper. Check the paper's per-channel validation before interpreting any single marker map."}]}
