"""Task dispatch and per-model readiness checks."""
from __future__ import annotations

import importlib.util

from . import gigatime, hex, patch, segment, slide, stpath, zeroshot

TASKS = {
    "embed_tiles": lambda ctx: patch.run_embed_tiles(ctx),
    "embed_wsi": lambda ctx: patch.run_embed_wsi(ctx),
    "zeroshot_tiles": lambda ctx: zeroshot.run_zeroshot_tiles(ctx),
    "zeroshot_wsi": lambda ctx: zeroshot.run_zeroshot_wsi(ctx),
    "slide_embed": lambda ctx: slide.run_slide_embed(ctx),
    "slide_zeroshot": lambda ctx: slide.run_slide_zeroshot(ctx),
    "segment_wsi": lambda ctx: segment.run_segment_wsi(ctx),
    "st_wsi": lambda ctx: stpath.run_st_wsi(ctx),
}
VMIF = {"gigatime": gigatime, "hex": hex}


def dispatch(ctx, task: str) -> dict:
    if task in ("vmif_tiles", "vmif_wsi"):
        mod = VMIF[ctx.model["runner"]]
        return mod.run_vmif_tiles(ctx) if task == "vmif_tiles" else mod.run_vmif_wsi(ctx)
    return TASKS[task](ctx)


def _has(*mods):
    missing = [m for m in mods if importlib.util.find_spec(m) is None]
    return missing


INSTALL_HINT = {
    "trident": "TRIDENT (git clone mahmoodlab/TRIDENT; pip install -e \".[patch-encoders,slide-encoders]\")",
    "conch": "CONCH (pip install git+https://github.com/Mahmoodlab/CONCH.git)",
    "open_clip": "open_clip_torch",
    "musk": "MUSK (lilab-stanford/MUSK package)",
    "huggingface_hub": "huggingface_hub",
}

VL_DEPS = {"conch": ["conch"], "musk": ["musk", "transformers"], "keep": ["transformers"],
           "plip": ["transformers"], "quiltnet": ["open_clip"]}


def runner_status(model: dict, settings) -> dict:
    """{'ready': bool, 'reason': str} — what this server still needs to run the model."""
    runner = model.get("runner")
    if runner is None:
        return {"ready": False, "reason": "No runner in this portal yet (catalogue entry only)."}
    if settings.mock:
        return {"ready": True, "reason": "Mock mode — outputs are synthetic."}
    need = ["torch", "numpy", "h5py", "huggingface_hub"]
    reason = []
    if runner in ("trident_patch", "trident_slide", "trident_seg") or any(
            t.endswith("_wsi") or t.startswith("slide") for t in model.get("tasks", [])):
        need.append("trident")
    if model.get("zeroshot_adapter"):
        need += VL_DEPS[model["zeroshot_adapter"]]
    if runner == "gigatime" and not (settings.gigatime_repo and (settings.gigatime_repo / "scripts" / "archs.py").exists()):
        reason.append("set gigatime_repo")
    if runner == "hex":
        if not (settings.hex_repo and (settings.hex_repo / "hex" / "infer_slide_h5_nolan48.py").exists()):
            reason.append("set hex_repo")
        if importlib.util.find_spec("musk") is None and not settings.musk_path:
            reason.append("install MUSK or set musk_path")
    if runner == "stpath":
        need.append("timm")
        if not (settings.stpath_repo and (settings.stpath_repo / "utils_data" / "symbol2ensembl.json").exists()):
            reason.append("set stpath_repo")
    if model.get("trident_name") == "titan" or "slide_zeroshot" in model.get("tasks", []):
        need.append("transformers")
    missing = _has(*dict.fromkeys(need))
    if missing:
        reason.insert(0, "install " + ", ".join(INSTALL_HINT.get(m, m) for m in missing))
    return {"ready": not reason, "reason": "; ".join(reason) or "Ready"}
