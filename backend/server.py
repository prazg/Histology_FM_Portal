"""
Histology FM Portal — inference backend.

The GitHub Pages front end is static; this FastAPI server is where models actually run.
Start it on a machine with a GPU (or in mock mode anywhere):

    python -m uvicorn server:app --host 127.0.0.1 --port 8000          # from backend/
    PORTAL_MOCK=1 python -m uvicorn server:app --port 8000              # no weights, wiring test only

Then open the portal and set "Backend URL" to http://127.0.0.1:8000.
"""
from __future__ import annotations

import importlib.util
import io
import json
import shutil
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image

from config import REGISTRY_PATH, load_settings
from jobs import JobManager
from runners import dispatch, runner_status
from runners.common import active_model_key, clear_model_cache

WSI_EXTS = {".svs", ".ndpi", ".tif", ".tiff", ".mrxs", ".scn", ".czi", ".png", ".jpg", ".jpeg"}

VERSION = "1.0.0"
settings = load_settings()
registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
MODELS = {m["id"]: m for m in registry["models"]}
manager = JobManager(settings, registry, dispatch)

app = FastAPI(title="Histology FM Portal backend", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    """Chromium asks permission before a public HTTPS page (GitHub Pages) calls a local server.
    Answering the preflight with this header lets the request through on browsers that check it."""
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def require_key(x_portal_key: Optional[str] = Header(default=None)):
    if settings.portal_key and x_portal_key != settings.portal_key:
        raise HTTPException(401, "Missing or wrong portal key. Set it under Connect in the portal.")


def _mods() -> dict:
    names = ["torch", "trident", "timm", "transformers", "open_clip", "conch", "musk", "h5py", "huggingface_hub"]
    return {n: importlib.util.find_spec(n) is not None for n in names}


@app.get("/api/health", dependencies=[Depends(require_key)])
def health():
    cuda, gpu = False, None
    try:
        import torch
        cuda = torch.cuda.is_available()
        gpu = torch.cuda.get_device_name(0) if cuda else None
    except ImportError:
        pass
    return {"ok": True, "version": VERSION, "mock": settings.mock, "device": settings.resolved_device(),
            "cuda": cuda, "gpu": gpu, "packages": _mods(), "registry_version": registry.get("version"),
            "wsi_roots": [str(p) for p in settings.allowed_wsi_roots], "queue": manager.q.qsize(),
            "cached_model": active_model_key()}


@app.post("/api/cache/clear", dependencies=[Depends(require_key)])
def clear_cache():
    unloaded = clear_model_cache()
    return {"cleared": True, "unloaded": unloaded}


@app.get("/api/wsi/browse", dependencies=[Depends(require_key)])
def browse_wsi():
    slides = []
    for root in settings.allowed_wsi_roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if len(slides) >= 300:
                break
            try:
                if p.is_file() and p.suffix.lower() in WSI_EXTS:
                    slides.append({"path": str(p.resolve()), "name": p.name, "root": str(root),
                                   "size_mb": round(p.stat().st_size / 1048576, 1)})
            except OSError:
                continue
    return {"slides": slides}


@app.get("/api/models", dependencies=[Depends(require_key)])
def models():
    return {m_id: runner_status(m, settings) for m_id, m in MODELS.items()}


def _safe_wsi_path(p: str) -> Path:
    path = Path(p).expanduser().resolve()
    if not settings.allowed_wsi_roots:
        raise HTTPException(400, "Server paths are disabled. Add folders to allowed_wsi_roots in backend/config.yaml.")
    if not any(path.is_relative_to(root) for root in settings.allowed_wsi_roots):
        raise HTTPException(403, f"{path} is outside the allowed slide folders.")
    if not path.is_file():
        raise HTTPException(404, f"No slide at {path}")
    return path


async def _save(upload: UploadFile, dest: Path) -> Path:
    limit = settings.max_upload_mb * 1024 * 1024
    size = 0
    with dest.open("wb") as f:
        while chunk := await upload.read(1 << 20):
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, f"{upload.filename} is larger than {settings.max_upload_mb} MB.")
            f.write(chunk)
    return dest


@app.post("/api/jobs", dependencies=[Depends(require_key)])
async def create_job(
    model_id: str = Form(...),
    task: str = Form(...),
    params: str = Form("{}"),
    wsi_path: Optional[str] = Form(None),
    tiles: List[UploadFile] = File(default=[]),
    wsi: Optional[UploadFile] = File(default=None),
    x_hf_token: Optional[str] = Header(default=None),
):
    model = MODELS.get(model_id)
    if model is None:
        raise HTTPException(404, f"Unknown model {model_id}")
    if task not in model.get("tasks", []):
        raise HTTPException(400, f"{model['name']} does not support {task}")
    status = runner_status(model, settings)
    if not status["ready"]:
        raise HTTPException(409, f"{model['name']} is not ready on this server: {status['reason']}")
    try:
        p = json.loads(params or "{}")
    except json.JSONDecodeError:
        raise HTTPException(400, "params must be JSON")

    needs = registry["tasks"][task]["input"]
    job = manager.create(model_id, task, p, x_hf_token)
    inp = job.dir / "input"
    if needs == "tiles":
        if not tiles:
            raise HTTPException(400, "Add at least one tile image.")
        for i, t in enumerate(tiles):
            name = Path(t.filename or f"tile_{i}.png").name
            job.inputs["tiles"].append(str(await _save(t, inp / f"{i:04d}_{name}")))
    else:
        if wsi is not None and wsi.filename:
            job.inputs["wsi"] = str(await _save(wsi, inp / Path(wsi.filename).name))
        elif wsi_path:
            job.inputs["wsi"] = str(_safe_wsi_path(wsi_path))
        else:
            raise HTTPException(400, "Upload a slide or give a server path.")
    manager.submit(job)
    return {"id": job.id}


@app.get("/api/jobs", dependencies=[Depends(require_key)])
def list_jobs():
    return [j.public(with_result=False) for j in sorted(manager.jobs.values(), key=lambda j: -j.created)]


def _job(job_id: str):
    job = manager.jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such job on this server (jobs are kept in memory until restart).")
    return job


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_key)])
def get_job(job_id: str):
    return _job(job_id).public()


@app.post("/api/jobs/{job_id}/cancel", dependencies=[Depends(require_key)])
def cancel_job(job_id: str):
    job = _job(job_id)
    if job.status in ("done", "error", "cancelled"):
        return {"id": job_id, "status": job.status}
    job.cancel_requested = True
    if job.status == "queued":
        job.status = "cancelled"
        job.stage = "Cancelled"
        job.persist()
    else:
        job.stage = "Cancelling…"
    return {"id": job_id, "status": job.status}


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_key)])
def delete_job(job_id: str):
    job = _job(job_id)
    if job.status == "running":
        job.cancel_requested = True
        raise HTTPException(409, "Cancel requested; the job can be removed once the current step stops.")
    job.status = "cancelled"
    manager.jobs.pop(job_id, None)
    shutil.rmtree(job.dir, ignore_errors=True)
    return {"deleted": job_id}


def _out_file(job_id: str, name: str) -> Path:
    job = _job(job_id)
    path = (job.dir / "out" / name).resolve()
    if not path.is_relative_to((job.dir / "out").resolve()) or not path.is_file():
        raise HTTPException(404, "No such file")
    return path


# Files are fetched with <img src> / download links, which cannot send headers,
# so these two routes also accept the key as ?key=.
def _key_q(key: Optional[str] = None, x_portal_key: Optional[str] = Header(default=None)):
    if settings.portal_key and settings.portal_key not in (key, x_portal_key):
        raise HTTPException(401, "Missing or wrong portal key.")


@app.get("/api/jobs/{job_id}/files/{name}", dependencies=[Depends(_key_q)])
def get_file(job_id: str, name: str):
    return FileResponse(_out_file(job_id, name), filename=name)


@app.get("/api/jobs/{job_id}/spatial/{panel}/{channel}", dependencies=[Depends(_key_q)])
def get_channel(job_id: str, panel: str, channel: int):
    m = np.load(_out_file(job_id, f"spatial_{panel}.npy"), mmap_mode="r")
    if not 0 <= channel < m.shape[1]:
        raise HTTPException(404, "No such channel")
    v = np.asarray(m[:, channel], dtype=np.float64)
    finite = v[np.isfinite(v)]
    return {"values": np.round(v, 5).tolist(),
            "min": float(finite.min()) if finite.size else 0.0,
            "max": float(finite.max()) if finite.size else 1.0}


@app.get("/api/jobs/{job_id}/patch", dependencies=[Depends(_key_q)])
def get_patch_crop(job_id: str, x: int, y: int, size: int = 256):
    """Return a high-resolution JPEG crop of a level-0 patch (or fallback to thumbnail crop)."""
    job = _job(job_id)
    size = max(16, min(size, 2048))
    wsi_path = (job.inputs or {}).get("wsi")
    im = None
    if wsi_path and Path(wsi_path).is_file():
        if settings.mock:
            try:
                full = Image.open(wsi_path).convert("RGB")
                im = full.crop((x, y, x + size, y + size)).resize((224, 224), Image.BILINEAR)
            except Exception:
                im = None
        else:
            try:
                from trident import load_wsi
                slide = load_wsi(slide_path=wsi_path, lazy_init=False)
                im = slide.read_region((int(x), int(y)), 0, (int(size), int(size))).convert("RGB").resize((224, 224), Image.BILINEAR)
            except Exception:
                im = None
    if im is None:
        thumb_p = _out_file(job_id, "thumb.jpg")
        scale = 1.0
        for p in (job.result or {}).get("panels") or []:
            if p.get("type") == "spatial":
                scale = float(p.get("scale") or 1.0)
                break
        th = Image.open(thumb_p).convert("RGB")
        tx, ty, ts = int(round(x * scale)), int(round(y * scale)), max(8, int(round(size * scale)))
        im = th.crop((tx, ty, tx + ts, ty + ts)).resize((224, 224), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return Response(content=buf.getvalue(), media_type="image/jpeg")
