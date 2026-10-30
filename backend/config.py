"""Backend settings. Read from backend/config.yaml (if present), then overridden by PORTAL_* env vars."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

HERE = Path(__file__).resolve().parent
REGISTRY_PATH = HERE.parent / "docs" / "models.json"


@dataclass
class Settings:
    work_dir: Path = HERE / "work"
    # Browser origins allowed to call this server. "*" is fine on localhost;
    # set your GitHub Pages origin (https://<user>.github.io) when tunnelling.
    origins: List[str] = field(default_factory=lambda: ["*"])
    # Shared secret. If set, every /api call must send header X-Portal-Key.
    # ALWAYS set this before exposing the server beyond 127.0.0.1.
    portal_key: Optional[str] = None
    # Server-side folders the portal may read slides from (wsi_path field).
    allowed_wsi_roots: List[Path] = field(default_factory=list)
    device: str = "auto"              # "auto" | "cuda" | "cuda:1" | "cpu"
    mock: bool = False                # deterministic stand-ins, no weights (UI / wiring tests only)
    max_upload_mb: int = 4096
    # External repos / weights for runners TRIDENT does not cover.
    gigatime_repo: Optional[Path] = None     # git clone https://github.com/prov-gigatime/GigaTIME
    hex_repo: Optional[Path] = None          # lilab-stanford/HEX clone (contains hex/infer_slide_h5_nolan48.py)
    musk_path: Optional[Path] = None         # folder that CONTAINS the `musk` package (if not pip-installed)
    hex_checkpoint: Optional[Path] = None    # hex_nolan48.pt (downloaded from HF if unset)
    hex_extra_pythonpath: List[Path] = field(default_factory=list)  # e.g. an openslide→tiffslide shim on Windows
    stpath_repo: Optional[Path] = None       # git clone https://github.com/Graph-and-Geometric-Learning/STPath
    stpath_weights: Optional[Path] = None    # stfm.pth (downloaded from HF tlhuang/STPath if unset)

    def resolved_device(self) -> str:
        if self.device != "auto":
            return self.device
        try:
            import torch
            return "cuda:0" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"


def _p(v) -> Optional[Path]:
    return Path(v).expanduser().resolve() if v not in (None, "") else None


def load_settings() -> Settings:
    s = Settings()
    cfg_path = Path(os.environ.get("PORTAL_CONFIG", HERE / "config.yaml"))
    data = {}
    if cfg_path.exists():
        import yaml
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}

    env = {
        "work_dir": os.environ.get("PORTAL_WORK_DIR"),
        "origins": os.environ.get("PORTAL_ORIGINS"),
        "portal_key": os.environ.get("PORTAL_KEY"),
        "allowed_wsi_roots": os.environ.get("PORTAL_WSI_ROOTS"),
        "device": os.environ.get("PORTAL_DEVICE"),
        "mock": os.environ.get("PORTAL_MOCK"),
    }
    for k, v in env.items():
        if v not in (None, ""):
            data[k] = v.split(os.pathsep) if k in ("origins", "allowed_wsi_roots") and isinstance(v, str) else v

    for k, v in data.items():
        if not hasattr(s, k):
            raise KeyError(f"Unknown setting {k!r} in {cfg_path}")
        if k == "mock":
            v = str(v).lower() in ("1", "true", "yes")
        elif k in ("max_upload_mb",):
            v = int(v)
        elif k in ("allowed_wsi_roots", "hex_extra_pythonpath"):
            v = [_p(x) for x in (v or [])]
        elif k == "origins":
            v = [v] if isinstance(v, str) else list(v)
        elif k in ("work_dir", "gigatime_repo", "hex_repo", "musk_path", "hex_checkpoint", "stpath_repo", "stpath_weights"):
            v = _p(v)
        setattr(s, k, v)
    s.work_dir.mkdir(parents=True, exist_ok=True)
    return s
