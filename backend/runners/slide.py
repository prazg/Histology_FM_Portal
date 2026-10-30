"""Slide encoders via TRIDENT, plus TITAN zero-shot (TITAN README / zeroshot_demo notebook)."""
from __future__ import annotations

import numpy as np

from .common import MockImageEncoder, mock_text, prepare_slide, read_patches, batched, l2n, softmax
from .zeroshot import parse_classes

# Copied verbatim from TITAN titan/utils.py (TEMPLATES), used by the official zero-shot demo.
TITAN_TEMPLATES = [
    "CLASSNAME.", "an image of CLASSNAME.", "the image shows CLASSNAME.", "the image displays CLASSNAME.",
    "the image exhibits CLASSNAME.", "an example of CLASSNAME.", "CLASSNAME is shown.", "this is CLASSNAME.",
    "I observe CLASSNAME.", "the pathology image shows CLASSNAME.", "a pathology image shows CLASSNAME.",
    "the pathology slide shows CLASSNAME.", "shows CLASSNAME.", "contains CLASSNAME.", "presence of CLASSNAME.",
    "CLASSNAME is present.", "CLASSNAME is observed.", "the pathology image reveals CLASSNAME.",
    "a microscopic image of showing CLASSNAME.", "histology shows CLASSNAME.", "CLASSNAME can be seen.",
    "the tissue shows CLASSNAME.", "CLASSNAME is identified.",
]


def _patch_feats(ctx, sp, penc_name, ps):
    if ctx.mock:
        enc = MockImageEncoder(penc_name, 256)
        return np.concatenate([enc(read_patches(sp, ch, ps)) for _, ch in batched(list(range(len(sp.coords))), 64)]), None
    from trident.patch_encoder_models import encoder_factory
    from .common import slide_features
    ctx.progress(0.2, f"Loading patch encoder {penc_name}")
    enc = encoder_factory(penc_name).eval().to(ctx.device)
    return slide_features(ctx, sp, enc, penc_name, 0, ps)


def _vector_panels(vec, name):
    return [{"type": "vector", "title": f"{name} slide embedding ({vec.size}-d)", "values": np.round(vec, 5).tolist()}]


def run_slide_embed(ctx) -> dict:
    m = ctx.model
    mag, ps = int(m["mag"]), int(m["patch_size"])  # fixed by the slide encoder's training setup
    sp = prepare_slide(ctx, mag, ps, max_patches=int(ctx.params.get("max_patches", 0)) or None)
    feats, h5 = _patch_feats(ctx, sp, m["patch_encoder"], ps)
    ctx.progress(0.85, f"Running slide encoder {m['trident_name']}")
    if ctx.mock:
        vec = l2n(feats.mean(0))
    else:
        import h5py
        from trident.slide_encoder_models import encoder_factory as slide_factory
        senc = slide_factory(m["trident_name"])
        out = sp.slide.extract_slide_features(patch_features_path=h5, slide_encoder=senc,
                                              save_features=str(ctx.scratch / f"slide_{m['trident_name']}"), device=ctx.device)
        with h5py.File(out, "r") as f:
            vec = np.asarray(f["features"][:], dtype=np.float32).reshape(-1)
    import h5py
    with h5py.File(ctx.out_path("slide_embedding.h5"), "w") as f:
        f.create_dataset("features", data=vec[None])
        f.attrs["encoder"] = m["trident_name"]
        f.attrs["patch_encoder"] = m["patch_encoder"]
        f.attrs["n_patches"] = len(feats)
    ctx.register("slide_embedding.h5", f"Slide embedding 1×{vec.size}")
    np.savetxt(ctx.out_path("slide_embedding.csv"), vec[None], delimiter=",", fmt="%.6g")
    ctx.register("slide_embedding.csv", "Slide embedding as one CSV row")
    panels = _vector_panels(vec, m["name"])
    if sp.contours:
        panels.append({"type": "image", "title": "Tissue segmentation (TRIDENT)", "src": sp.contours})
    else:
        panels.append({"type": "image", "title": "Slide thumbnail", "src": sp.thumb})
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Patches", "value": len(feats)},
                        {"label": "Patch encoder", "value": m["patch_encoder"]}, {"label": "Dim", "value": int(vec.size)},
                        {"label": "L2 norm", "value": round(float(np.linalg.norm(vec)), 4)}],
            "panels": panels}


def run_slide_zeroshot(ctx) -> dict:
    m = ctx.model
    if m["trident_name"] != "titan":
        raise ValueError("Slide zero-shot is only wired for TITAN.")
    names_c, prompts = parse_classes(ctx.params.get("classes"))
    sp = prepare_slide(ctx, int(m["mag"]), int(m["patch_size"]), max_patches=int(ctx.params.get("max_patches", 0)) or None)
    feats, h5 = _patch_feats(ctx, sp, "conch_v15", int(m["patch_size"]))
    ctx.progress(0.85, "TITAN: slide embedding + zero-shot classifier")
    if ctx.mock:
        emb = l2n(feats.mean(0)[:128])
        T = l2n(np.stack([mock_text("titan", ps, 128).mean(0) for ps in prompts]))
        scores = softmax(50 * (T @ emb))
    else:
        import h5py
        import torch
        from transformers import AutoModel
        titan = AutoModel.from_pretrained("MahmoodLab/TITAN", trust_remote_code=True).to(ctx.device).eval()
        with h5py.File(h5, "r") as f:
            features = torch.from_numpy(f["features"][:]).to(ctx.device)
            coords = torch.from_numpy(f["coords"][:]).to(ctx.device)
            p0 = f["coords"].attrs["patch_size_level0"]
        ac = torch.autocast("cuda", torch.float16) if ctx.device.startswith("cuda") else torch.autocast("cpu", enabled=False)
        with ac, torch.inference_mode():
            slide_emb = titan.encode_slide_from_patch_features(features, coords, p0)
            classifier = titan.zero_shot_classifier(prompts, TITAN_TEMPLATES, device=ctx.device)
            s = titan.zero_shot(slide_emb, classifier)
        scores = np.asarray(s.float().cpu()).reshape(-1)[:len(names_c)]
        emb = slide_emb.float().cpu().numpy().reshape(-1)
    np.savetxt(ctx.out_path("titan_slide_embedding.csv"), emb[None], delimiter=",", fmt="%.6g")
    ctx.register("titan_slide_embedding.csv", f"TITAN slide embedding 1×{emb.size}")
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Predicted", "value": names_c[int(np.argmax(scores))]},
                        {"label": "Patches", "value": len(feats)}],
            "panels": [{"type": "bars", "title": "TITAN zero-shot scores (normalised similarity)", "labels": names_c,
                        "rows": ["Slide"], "values": [np.round(scores, 4).tolist()], "percent": True},
                       {"type": "note", "text": f"Each class prompt is expanded with TITAN's {len(TITAN_TEMPLATES)} official templates."},
                       *_vector_panels(emb, "TITAN")]}
