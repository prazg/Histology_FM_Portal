"""Print what this machine can run: hardware, missing pieces, cached weights, and model suggestions.

    python check_setup.py            # full report
    python check_setup.py --short    # one screen (used by the start scripts)
"""
from __future__ import annotations

import json
import sys

from config import REGISTRY_PATH, load_settings
import hardware
from runners import runner_status
from weights import WeightsManager, hf_cache_dir


def tier(m, rules):
    gb = m.get("runtime_weights_gb")
    if gb is None:
        return None
    return next(t for t in rules["tiers"] if gb <= t["max_gb"])


def main(short: bool = False) -> None:
    s = load_settings()
    reg = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    rules = reg["hardware_rules"]
    hw = hardware.detect(hf_cache_dir())
    vram = hardware.best_vram_gb(hw)

    print("─" * 64)
    print(f"Histology FM Portal · {hw['os']} · Python {hw['python']}" + ("  [MOCK MODE]" if s.mock else ""))
    print(f"CPU   {hw['cpu_cores']} cores · RAM {hw['ram_total_gb'] or '?'} GB")
    if hw["gpus"]:
        for g in hw["gpus"]:
            print(f"GPU   {g['name']} · {g['vram_total_gb']} GB (CUDA {hw['torch_cuda']})")
    else:
        print("GPU   none usable by PyTorch — models will run on the CPU")
    print(f"Torch {hw['torch'] or 'not installed'} · weights cache {hf_cache_dir()} ({hw.get('weights_disk_free_gb', '?')} GB free)")
    for w in hw["warnings"]:
        print(f"!     {w}")

    models = [m for m in reg["models"] if m.get("runner")]
    status = {m["id"]: runner_status(m, s) for m in models}
    ready = [m for m in models if status[m["id"]]["ready"]]
    print(f"\nReady to run: {len(ready)} of {len(models)} models")
    reasons: dict = {}
    for m in models:
        if not status[m["id"]]["ready"]:
            reasons.setdefault(status[m["id"]]["reason"], []).append(m["name"])
    for r, names in reasons.items():
        print(f"  needs: {r}\n         ({', '.join(names[:6])}{' …' if len(names) > 6 else ''})")

    wm = WeightsManager(reg, mock=s.mock)
    ws = wm.all_status()
    cached = [m["name"] for m in models if ws[m["id"]]["overall"] == "cached"]
    print(f"\nWeights already downloaded: {len(cached)} models" + (f" ({', '.join(cached[:8])}{' …' if len(cached) > 8 else ''})" if cached else ""))

    good, cpu_ok, too_big = [], [], []
    for m in models:
        gb, t = m.get("runtime_weights_gb"), tier(m, rules)
        if gb is None or t is None:
            continue
        if vram:
            (good if vram >= gb + rules["vram_headroom_gb"] else too_big).append(m["name"])
        else:
            (cpu_ok if t["id"] == "small" else good if t["id"] == "medium" else too_big).append(m["name"])
    if vram:
        print(f"\nFits your {vram} GB GPU: {len(good)} models" + (f"\nToo large for it: {', '.join(too_big)}" if too_big else ""))
    else:
        print(f"\nOn this CPU-only machine (rule of thumb):\n  fine:          {', '.join(cpu_ok)}"
              f"\n  tiles only:    {len(good)} mid-size models (ViT-L class)\n  needs a GPU:   {len(too_big)} large models")
    if not short:
        print("\nPer-model detail:")
        for m in models:
            st = status[m["id"]]
            print(f"  {m['name']:30s} {str(m.get('runtime_weights_gb')):>6} GB  {ws[m['id']]['overall']:8s}  {st['reason']}")
    print("─" * 64)


if __name__ == "__main__":
    main(short="--short" in sys.argv)
