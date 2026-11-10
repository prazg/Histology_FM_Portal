"""Guided first-time setup, driven step by step from the portal's setup wizard.

Safety model
- Off unless `setup_enabled: true` (the installer sets it; the wizard's last step turns it off).
- Only answers requests from this machine (loopback), and still requires the portal key.
- Runs a fixed list of install steps whose commands are built here — the browser can only pick a step id,
  never send a command. Every step is started by the user clicking it in the wizard.
- Hugging Face *token* only (never a password); it is validated, saved with huggingface_hub.login, never echoed.
Set PORTAL_SETUP_DRYRUN=1 to log the commands without running them (used by the tests)."""
from __future__ import annotations

import io
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from config import HERE, config_path, update_config

EXTERNAL = HERE / "external"
DRYRUN = os.environ.get("PORTAL_SETUP_DRYRUN") == "1"
REPOS = {
    "TRIDENT": "https://github.com/mahmoodlab/TRIDENT",
    "GigaTIME": "https://github.com/prov-gigatime/GigaTIME",
    "HEX": "https://github.com/lilab-stanford/HEX",
    "STPath": "https://github.com/Graph-and-Geometric-Learning/STPath",
    "MUSK": "https://github.com/lilab-stanford/MUSK",
}
LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}


def _uv() -> Optional[str]:
    found = shutil.which("uv")
    if found:
        return found
    home = Path.home()
    for c in (home / ".local" / "bin" / "uv", home / ".local" / "bin" / "uv.exe", home / ".cargo" / "bin" / "uv",
              home / ".cargo" / "bin" / "uv.exe"):
        if c.exists():
            return str(c)
    return None


def _env() -> dict:
    env = os.environ.copy()
    # uv: trust the OS certificate store (university/NHS proxies).
    env.setdefault("UV_SYSTEM_CERTS", "true")
    return env


def pip_install(args: List[str], torch_backend: bool = False) -> List[str]:
    uv = _uv()
    if uv:
        cmd = [uv, "pip", "install", "--python", sys.executable]
        if torch_backend:
            cmd.append("--torch-backend=auto")      # picks the CUDA build matching the NVIDIA driver, else CPU
        return cmd + args
    return [sys.executable, "-m", "pip", "install"] + args


# ── checks (run in a fresh interpreter: packages installed after the server started are not importable here) ──
PROBE = r"""
import json, importlib.util as u
out = {}
for m in ["torch", "trident", "conch", "musk", "open_clip", "transformers", "timm", "anndata", "scanpy", "openslide"]:
    out[m] = u.find_spec(m) is not None
if out["torch"]:
    import torch
    out["torch_version"] = torch.__version__
    out["torch_cuda"] = torch.version.cuda
    out["cuda_available"] = torch.cuda.is_available()
    out["gpu"] = torch.cuda.get_device_name(0) if out["cuda_available"] else None
print(json.dumps(out))
"""


def probe() -> dict:
    try:
        r = subprocess.run([sys.executable, "-c", PROBE], capture_output=True, text=True, timeout=180)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


class Tasks:
    """One install step at a time, with a live log."""

    def __init__(self):
        self.cur: Optional[dict] = None
        self.lock = threading.Lock()
        self.restart_needed = False

    def start(self, step_id: str, fn: Callable[["Tasks"], None]) -> dict:
        with self.lock:
            if self.cur and self.cur["status"] == "running":
                raise HTTPException(409, f"'{self.cur['step']}' is still running.")
            self.cur = {"step": step_id, "status": "running", "log": [], "started": time.time(), "finished": None}
        threading.Thread(target=self._run, args=(fn,), daemon=True).start()
        return self.public()

    def _run(self, fn):
        try:
            fn(self)
            self.cur["status"] = "done"
            self.restart_needed = True
        except Exception as e:
            self.log(f"ERROR: {type(e).__name__}: {e}")
            self.cur["status"] = "error"
        finally:
            self.cur["finished"] = time.time()

    def log(self, line: str):
        self.cur["log"].append(line.rstrip()[:500])
        del self.cur["log"][:-400]

    def sh(self, cmd: List[str], cwd: Optional[Path] = None):
        shown = " ".join(f'"{c}"' if " " in c else c for c in cmd)
        self.log(f"$ {shown}")
        if DRYRUN:
            time.sleep(0.2)
            self.log("(dry run — not executed)")
            return
        p = subprocess.Popen(cmd, cwd=cwd, env=_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, errors="replace", bufsize=1)
        for line in p.stdout:
            self.log(line)
        if p.wait() != 0:
            raise RuntimeError(f"command failed with exit code {p.returncode}")

    def fetch(self, name: str) -> Path:
        """Clone (git) or download (zip) a GitHub repo into backend/external/<name>."""
        url, dest = REPOS[name], EXTERNAL / name
        EXTERNAL.mkdir(parents=True, exist_ok=True)
        git = shutil.which("git")
        if dest.exists() and (dest / ".git").exists() and git:
            self.sh([git, "-C", str(dest), "pull", "--ff-only"])
        elif dest.exists() and any(dest.iterdir()):
            self.log(f"{dest} already exists — keeping it")
        elif git:
            self.sh([git, "clone", "--depth", "1", url + ".git", str(dest)])
        else:
            zurl = f"{url}/archive/refs/heads/main.zip"
            self.log(f"Git not found — downloading {zurl}")
            if not DRYRUN:
                with urllib.request.urlopen(zurl, timeout=120) as r:
                    data = r.read()
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    top = z.namelist()[0].split("/")[0]
                    for member in z.infolist():
                        rel = member.filename[len(top) + 1:]
                        if not rel or member.is_dir():
                            continue
                        target = (dest / rel).resolve()
                        if not str(target).startswith(str(dest.resolve())):
                            continue  # ignore path traversal entries
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(z.read(member))
        self.log(f"✓ {name} in {dest}")
        return dest

    def public(self) -> dict:
        if not self.cur:
            return {"step": None, "status": "idle", "log": [], "restart_needed": self.restart_needed}
        return {**{k: v for k, v in self.cur.items()}, "restart_needed": self.restart_needed}


# ── the steps ─────────────────────────────────────────────────────────────────
def step_torch(t: Tasks):
    t.log("Installing PyTorch. With uv, the build is matched to this machine (CUDA if an NVIDIA driver is found, else CPU).")
    if not _uv():
        t.log("uv not found — using pip. On Windows pip installs the CPU build; see pytorch.org for a CUDA build.")
    t.sh(pip_install(["torch", "torchvision"], torch_backend=True))


def step_trident(t: Tasks):
    if not shutil.which("git"):
        raise RuntimeError("Git is required here (TRIDENT installs CONCH, MUSK and GigaPath straight from GitHub). "
                           "Install Git, restart the server, then retry.")
    dest = t.fetch("TRIDENT")
    t.sh(pip_install(["-e", f"{dest}[patch-encoders,slide-encoders]"]))
    t.sh(pip_install(["open_clip_torch", "transformers"]))


def step_gigatime(t: Tasks):
    dest = t.fetch("GigaTIME")
    update_config({"gigatime_repo": str(dest)})
    t.log("✓ gigatime_repo set in config.yaml")


def step_hex(t: Tasks):
    dest = t.fetch("HEX")
    pr = probe() if not DRYRUN else {"musk": False}
    if not pr.get("musk"):
        musk = t.fetch("MUSK")
        # --no-deps: MUSK's requirements.txt pins torch 2.0.1, which would downgrade PyTorch.
        t.sh(pip_install(["--no-deps", "-e", str(musk)]))
        t.sh(pip_install(["einops", "sentencepiece", "ftfy", "fairscale", "timm"]))
    update_config({"hex_repo": str(dest)})
    t.log("✓ hex_repo set in config.yaml")


def step_stpath(t: Tasks):
    dest = t.fetch("STPath")
    t.sh(pip_install(["anndata", "scanpy"]))
    update_config({"stpath_repo": str(dest)})
    t.log("✓ stpath_repo set in config.yaml")


STEPS = {
    "torch": {"title": "PyTorch", "fn": step_torch, "done": lambda p, s: p.get("torch", False)},
    "trident": {"title": "TRIDENT + patch/slide encoders (incl. CONCH, MUSK, GigaPath)", "fn": step_trident,
                "done": lambda p, s: p.get("trident", False) and p.get("open_clip", False)},
    "gigatime": {"title": "GigaTIME (virtual mIF)", "fn": step_gigatime, "optional": True,
                 "done": lambda p, s: bool(s.gigatime_repo and (s.gigatime_repo / "scripts" / "archs.py").exists())},
    "hex": {"title": "HEX (virtual CODEX)", "fn": step_hex, "optional": True,
            "done": lambda p, s: bool(s.hex_repo and (s.hex_repo / "hex").exists()) and p.get("musk", False)},
    "stpath": {"title": "STPath (spatial expression)", "fn": step_stpath, "optional": True,
               "done": lambda p, s: bool(s.stpath_repo and (s.stpath_repo / "utils_data").exists()) and p.get("anndata", False)},
}


def make_router(settings, require_key, weights) -> APIRouter:
    tasks = Tasks()
    cache = {"probe": None, "t": 0.0}
    router = APIRouter(prefix="/api/setup")

    def guard(request: Request, _=Depends(require_key)):
        if not settings.setup_enabled:
            raise HTTPException(403, "Guided setup is off on this server (setup_enabled: false in config.yaml).")
        host = request.client.host if request.client else ""
        if host not in LOOPBACK:
            raise HTTPException(403, "Guided setup only works from the computer running the server.")

    def _probe(refresh: bool) -> dict:
        if refresh or cache["probe"] is None or time.time() - cache["t"] > 600:
            cache["probe"], cache["t"] = probe(), time.time()
        return cache["probe"]

    def _hf_user() -> Optional[str]:
        try:
            from huggingface_hub import get_token, whoami
            tok = get_token()
            return whoami(token=tok)["name"] if tok else None
        except Exception:
            return None

    @router.get("/status", dependencies=[Depends(guard)])
    def status(refresh: bool = False):
        from config import load_settings
        s = load_settings()  # re-read: steps edit config.yaml
        pr = _probe(refresh)
        return {
            "os": f"{platform.system()} {platform.release()}", "python": platform.python_version(),
            "python_path": sys.executable, "in_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
            "uv": _uv(), "git": shutil.which("git"), "probe": pr,
            "steps": [{"id": k, "title": v["title"], "optional": v.get("optional", False), "done": bool(v["done"](pr, s))}
                      for k, v in STEPS.items()],
            "hf_user": _hf_user(), "config": str(config_path()), "mock": settings.mock,
            "wsi_roots": [str(p) for p in settings.allowed_wsi_roots], "origins": settings.origins,
            "task": tasks.public(), "dry_run": DRYRUN,
        }

    @router.post("/run/{step_id}", dependencies=[Depends(guard)])
    def run(step_id: str):
        if step_id not in STEPS:
            raise HTTPException(404, "Unknown setup step")
        cache["probe"] = None
        return tasks.start(step_id, STEPS[step_id]["fn"])

    @router.get("/task", dependencies=[Depends(guard)])
    def task():
        return tasks.public()

    @router.post("/hf_token", dependencies=[Depends(guard)])
    def hf_token(token: str = Body(..., embed=True)):
        token = token.strip()
        if not token.startswith("hf_"):
            raise HTTPException(400, "That doesn't look like a Hugging Face access token (they start with hf_).")
        if DRYRUN:
            return {"user": "dry-run-user"}
        try:
            from huggingface_hub import login, whoami
            user = whoami(token=token)["name"]
            login(token=token, add_to_git_credential=False, skip_if_logged_in=False)
        except TypeError:   # older huggingface_hub without skip_if_logged_in
            from huggingface_hub import login, whoami
            user = whoami(token=token)["name"]
            login(token=token, add_to_git_credential=False)
        except Exception as e:
            raise HTTPException(400, f"Hugging Face rejected the token ({type(e).__name__}). Create a new read token and try again.")
        return {"user": user}

    @router.post("/wsi_roots", dependencies=[Depends(guard)])
    def wsi_roots(paths: List[str] = Body(..., embed=True)):
        good, bad = [], []
        for p in paths:
            q = Path(p.strip().strip('"')).expanduser()
            (good if p.strip() and q.is_dir() else bad).append(str(q.resolve()) if q.is_dir() else p)
        if bad:
            raise HTTPException(400, "Not a folder on this computer: " + ", ".join(bad))
        update_config({"allowed_wsi_roots": good})
        settings.allowed_wsi_roots = [Path(g) for g in good]
        return {"wsi_roots": good}

    @router.post("/mode", dependencies=[Depends(guard)])
    def mode(mock: bool = Body(..., embed=True)):
        update_config({"mock": mock})
        settings.mock = mock
        weights.mock = mock
        return {"mock": mock}

    @router.post("/restart", dependencies=[Depends(guard)])
    def restart():
        # Exit code 3 tells the start script's loop to start the server again (fresh imports).
        threading.Timer(0.6, lambda: os._exit(3)).start()
        return {"restarting": True}

    @router.post("/finish", dependencies=[Depends(guard)])
    def finish():
        update_config({"setup_enabled": False})
        settings.setup_enabled = False
        return {"setup_enabled": False}

    return router
