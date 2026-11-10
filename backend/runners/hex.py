"""HEX nolan48 — 48-marker virtual CODEX on a MUSK backbone (lilab-stanford/HEX).

Slides: runs the repo's own hex/infer_slide_h5_nolan48.py as a subprocess on a CLAM-style coords h5
(coords at level 0, attrs patch_level=0, patch_size=<level-0 px>), exactly as its README describes.
Tiles: loads hex_architecture.CustomModel(visual_output_dim=1024, num_outputs=48) in-process with the same
transform as that script (Resize 384, Inception mean/std)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import numpy as np

from .common import batched, load_tiles, prepare_slide, save_thumbs

_model = {}


def _paths(ctx):
    s = ctx.settings
    if not s.hex_repo or not (s.hex_repo / "hex" / "infer_slide_h5_nolan48.py").exists():
        raise RuntimeError("Set hex_repo in backend/config.yaml to a clone of lilab-stanford/HEX")
    ckpt = s.hex_checkpoint
    if not ckpt:
        from huggingface_hub import hf_hub_download
        ctx.progress(0.02, "Downloading zli1893/hex_nolan48")
        ckpt = Path(hf_hub_download("zli1893/hex_nolan48", "hex_nolan48.pt"))
    extra = [str(p) for p in s.hex_extra_pythonpath] + ([str(s.musk_path)] if s.musk_path else []) + [str(s.hex_repo / "hex")]
    return ckpt, extra


def _mock(ctx, n):
    rng = np.random.default_rng(48)
    base = rng.random((1, 48)).astype(np.float32)
    return np.clip(base + 0.15 * rng.standard_normal((n, 48)).astype(np.float32), 0, None)


def run_vmif_tiles(ctx) -> dict:
    names, imgs = load_tiles(ctx.inputs["tiles"])
    markers = ctx.model["channels"]
    if ctx.mock:
        P = _mock(ctx, len(imgs))
    else:
        import torch
        from timm.data.constants import IMAGENET_INCEPTION_MEAN, IMAGENET_INCEPTION_STD
        from torchvision import transforms
        ckpt, extra = _paths(ctx)
        for p in extra:
            if p not in sys.path:
                sys.path.insert(0, p)
        if "m" not in _model:
            from musk import modeling  # noqa: F401 — registers MUSK with timm
            from hex_architecture import CustomModel
            ctx.progress(0.05, "Loading HEX (MUSK backbone needs access to xiangjx/musk)")
            m = CustomModel(visual_output_dim=1024, num_outputs=48)
            res = m.load_state_dict(torch.load(ckpt, map_location="cpu"), strict=False)
            ctx.log(f"load_state_dict: missing={len(res.missing_keys)} unexpected={len(res.unexpected_keys)} "
                    "(missing frozen MUSK layers are expected; unexpected should be 0)")
            _model["m"] = m.eval().to(ctx.device)
        model = _model["m"]
        tf = transforms.Compose([transforms.Resize((384, 384)), transforms.ToTensor(),
                                 transforms.Normalize(mean=IMAGENET_INCEPTION_MEAN, std=IMAGENET_INCEPTION_STD)])
        out = []
        for i, chunk in batched(imgs, 16):
            x = torch.stack([tf(im) for im in chunk]).to(ctx.device)
            with torch.no_grad():
                o, _ = model(x)
            out.append(o.float().cpu().numpy())
            ctx.progress(0.1 + 0.8 * (i + len(chunk)) / len(imgs))
        P = np.concatenate(out)
    thumbs = save_thumbs(ctx, names, imgs)
    np.savetxt(ctx.out_path("hex_predictions.csv"), P, delimiter=",", header=",".join(markers), comments="", fmt="%.5g")
    ctx.register("hex_predictions.csv", "Predicted marker expression per tile (48 markers)")
    return {"summary": [{"label": "Tiles", "value": len(imgs)}, {"label": "Markers", "value": 48}],
            "panels": [{"type": "bars", "title": "Predicted marker expression", "labels": markers, "rows": names,
                        "values": P.round(4).tolist(), "thumbs": thumbs},
                       {"type": "matrix", "title": "Tiles × markers", "rows": names, "cols": markers,
                        "values": P.round(3).tolist(), "vmin": float(P.min()), "vmax": float(P.max())}]}


def run_vmif_wsi(ctx) -> dict:
    markers = ctx.model["channels"]
    footprint = float(ctx.params.get("footprint_um", 56.0))
    mag = 20
    ps = int(round(footprint / 0.5))   # px at 20x (0.5 µm/px) covering the footprint
    sp = prepare_slide(ctx, mag, ps, max_patches=int(ctx.params.get("max_patches", 0)) or None)
    n = len(sp.coords)
    if ctx.mock:
        P = _mock(ctx, n)
        coords = sp.coords
    else:
        import h5py
        ckpt, extra = _paths(ctx)
        clam = ctx.scratch / "hex_coords.h5"
        with h5py.File(clam, "w") as f:
            ds = f.create_dataset("coords", data=np.asarray(sp.coords, dtype=np.int64))
            ds.attrs["patch_level"] = 0
            ds.attrs["patch_size"] = int(round(sp.patch0))
        out_h5 = ctx.scratch / "hex_pred.h5"
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(extra + [env.get("PYTHONPATH", "")])
        cmd = [sys.executable, str(ctx.settings.hex_repo / "hex" / "infer_slide_h5_nolan48.py"),
               "--wsi", ctx.inputs["wsi"], "--coord-h5", str(clam), "--checkpoint", str(ckpt),
               "--output-h5", str(out_h5), "--batch-size", str(int(ctx.params.get("batch_size", 32))), "--num-workers", "0"]
        ctx.progress(0.3, f"Running HEX on {n} patches ({footprint:.0f} µm footprint)")
        r = subprocess.run(cmd, env=env, capture_output=True, text=True)
        for ln in (r.stdout + r.stderr).splitlines()[-25:]:
            ctx.log(ln)
        if r.returncode != 0:
            raise RuntimeError(f"HEX exited {r.returncode} — see log")
        with h5py.File(out_h5, "r") as f:
            P = f["codex_prediction"][:]
            coords = f["coords"][:]
        ctx.out_path("hex_pred.h5").write_bytes(out_h5.read_bytes())
        ctx.register("hex_pred.h5", "HEX output (coords, codex_prediction [N, 48])")
    np.savetxt(ctx.out_path("hex_patch_predictions.csv"), np.column_stack([coords, P]), delimiter=",",
               header="x,y," + ",".join(markers), comments="", fmt="%.5g")
    ctx.register("hex_patch_predictions.csv", "Per-patch marker predictions with level-0 coordinates")
    rows = [[mk, round(float(P[:, i].mean()), 4), round(float(P[:, i].std()), 4),
             round(float(np.percentile(P[:, i], 5)), 4), round(float(np.percentile(P[:, i], 95)), 4)]
            for i, mk in enumerate(markers)]
    rows.sort(key=lambda r: -r[2])
    chans = [{"name": mk, "kind": "continuous"} for mk in markers]
    default = markers.index("CD68") if "CD68" in markers else 0
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Patches", "value": int(len(P))},
                        {"label": "Footprint", "value": f"{footprint:.0f} µm"}],
            "panels": [ctx.spatial_panel("hex", "HEX virtual CODEX", coords, sp.patch0, P, chans, sp.thumb, sp.scale, default=default),
                       {"type": "table", "title": "Markers ranked by spatial variability", "columns": ["Marker", "Mean", "SD", "P5", "P95"], "rows": rows},
                       {"type": "note", "tone": "warn", "text": "HEX nolan48 was trained on the Bern/Nolan dataset. Check how well that training tissue matches yours before interpreting markers."}]}
