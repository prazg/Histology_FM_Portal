"""Weights manager: which models' weights are already on this server, who has access, and pre-downloading.

Weights go to the standard Hugging Face cache (HF_HOME / HF_HUB_CACHE), the same place TRIDENT, timm and
transformers look, so a pre-download here is reused by the real run. TRIDENT's tissue segmenters keep their
own cache, so those are fetched through TRIDENT itself. Nothing is ever written into the git repository."""
from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional


# Checkpoint names used by TRIDENT's segmentation loaders (segmentation_models/load.py).
SEG_CKPT = {"hest": "deeplabv3_seg_v4.ckpt", "grandqc": "Tissue_Detection_MPP10.pth"}


def hf_cache_dir() -> str:
    try:
        from huggingface_hub import constants
        return str(constants.HF_HUB_CACHE)
    except Exception:
        import os
        return os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")


def _cached(repo: str, filename: str, rtype: str) -> bool:
    from huggingface_hub import try_to_load_from_cache
    return isinstance(try_to_load_from_cache(repo, filename, repo_type=rtype), str)


class WeightsManager:
    def __init__(self, registry: dict, mock: bool = False):
        self.models = {m["id"]: m for m in registry["models"]}
        self.mock = mock
        self.state: Dict[str, dict] = {}          # model_id → {status, message, progress}
        self.access: Dict[str, str] = {}          # repo → ok | no-access | not-found | error
        self._mock_cached: set = set()
        self._lock = threading.Lock()
        self._queue: List[tuple] = []
        self._wake = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()

    # ── status ──────────────────────────────────────────────────────────
    def _component_ids(self, mid: str) -> List[str]:
        return [mid] + list(self.models[mid].get("requires_models", []))

    def _file_status(self, w: dict) -> Optional[bool]:
        if w["via"] == "hf":
            if self.mock:
                return w["repo"] in self._mock_cached
            try:
                return all(_cached(w["repo"], f, w.get("type", "model")) for f in w["files"])
            except Exception:
                return None
        if w["via"] == "trident-seg":
            if self.mock:
                return w["name"] in self._mock_cached
            try:  # TRIDENT downloads segmenter checkpoints into its own cache dir (trident.IO.get_dir)
                import os
                from trident.IO import get_dir
                return os.path.exists(os.path.join(get_dir(), SEG_CKPT[w["name"]]))
            except Exception:
                return None
        return None  # external

    def status(self, mid: str) -> dict:
        parts = []
        for cid in self._component_ids(mid):
            for w in self.models[cid]["weights"]:
                parts.append({"model": cid, "via": w["via"], "repo": w.get("repo"), "gb": w.get("gb"),
                              "cached": self._file_status(w), "access": self.access.get(w.get("repo") or "", "unknown"),
                              "note": w.get("note"), "url": w.get("url")})
        known = [p["cached"] for p in parts if p["cached"] is not None]
        if not parts:
            overall = "none"
        elif any(p["via"] == "external" for p in parts):
            overall = "manual"
        elif known and all(known) and len(known) == len(parts):
            overall = "cached"
        elif any(known):
            overall = "partial"
        elif not known:
            overall = "unknown"
        else:
            overall = "missing"
        missing_gb = sum(p["gb"] or 0 for p in parts if p["cached"] is False)
        st = self.state.get(mid, {})
        return {"overall": overall, "parts": parts, "missing_gb": round(missing_gb, 2),
                "download": st.get("status", "idle"), "message": st.get("message"), "progress": st.get("progress", 0.0)}

    def all_status(self) -> dict:
        return {mid: self.status(mid) for mid in self.models}

    # ── access ──────────────────────────────────────────────────────────
    def check_access(self, repos: List[tuple], token: Optional[str]) -> Dict[str, str]:
        """repos: [(repo_id, repo_type)]. Uses HfApi.auth_check where available."""
        out = {}
        for repo, rtype in repos:
            if self.mock:
                out[repo] = "ok"
                continue
            try:
                from huggingface_hub import HfApi
                api = HfApi(token=token or None)
                if hasattr(api, "auth_check"):
                    api.auth_check(repo, repo_type=rtype)
                else:  # older huggingface_hub
                    api.model_info(repo, files_metadata=False) if rtype == "model" else api.dataset_info(repo)
                out[repo] = "ok"
            except Exception as e:  # classify without depending on exact exception module layout
                name = type(e).__name__
                out[repo] = "no-access" if "Gated" in name else "not-found" if "NotFound" in name else "error"
        self.access.update(out)
        return out

    # ── downloads ───────────────────────────────────────────────────────
    def enqueue(self, mid: str, token: Optional[str]) -> dict:
        with self._lock:
            st = self.state.get(mid, {})
            if st.get("status") in ("queued", "downloading"):
                return self.status(mid)
            self.state[mid] = {"status": "queued", "message": "Waiting to download", "progress": 0.0}
            self._queue.append((mid, token))
        self._wake.set()
        return self.status(mid)

    def _worker(self):
        while True:
            self._wake.wait()
            with self._lock:
                if not self._queue:
                    self._wake.clear()
                    continue
                mid, token = self._queue.pop(0)
            try:
                self._download(mid, token)
                self.state[mid] = {"status": "done", "message": "Weights are on this server.", "progress": 1.0}
            except Exception as e:
                name = type(e).__name__
                from jobs import friendly_hint
                msg = ("No access: request it on the model's Hugging Face page, then log in on the server (hf auth login) "
                       "or add your token under Connect." if "Gated" in name else f"{name}: {e}{friendly_hint(e)}")
                self.state[mid] = {"status": "error", "message": msg, "progress": 0.0}

    def _download(self, mid: str, token: Optional[str]):
        items = [(cid, w) for cid in self._component_ids(mid) for w in self.models[cid]["weights"]]
        total = sum(w.get("gb") or 0 for _, w in items) or 1.0
        done = 0.0
        for cid, w in items:
            self.state[mid].update(status="downloading", message=f"{w.get('repo') or w.get('name')} ({w.get('gb') or '?'} GB)")
            if self.mock:
                for _ in range(5):
                    time.sleep(0.15)
                self._mock_cached.add(w.get("repo") or w.get("name"))
            elif w["via"] == "hf":
                from huggingface_hub import hf_hub_download
                for f in w["files"]:
                    hf_hub_download(w["repo"], f, repo_type=w.get("type", "model"), token=token or None)
            elif w["via"] == "trident-seg":
                from trident.segmentation_models import segmentation_model_factory
                segmentation_model_factory(w["name"])          # downloads into TRIDENT's cache
            elif w["via"] == "external":
                raise RuntimeError(w.get("note") or "This model's weights must be downloaded manually.")
            done += w.get("gb") or 0
            self.state[mid]["progress"] = done / total
