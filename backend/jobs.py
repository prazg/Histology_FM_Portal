"""Single-GPU job queue: one worker thread runs jobs in submission order."""
from __future__ import annotations

import json
import os
import queue
import shutil
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np


class JobCancelledError(RuntimeError):
    """Raised inside JobContext.progress when a running job is cancelled."""


class JobContext:
    """Everything a runner needs. Runners write outputs only through this object."""

    def __init__(self, job: "Job", settings, model: dict, device: str):
        self.job = job
        self.settings = settings
        self.model = model
        self.params: Dict[str, Any] = job.params
        self.device = device
        self.mock = settings.mock
        self.dir = job.dir
        self.out = job.dir / "out"
        self.scratch = job.dir / "scratch"
        self.out.mkdir(parents=True, exist_ok=True)
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.inputs = job.inputs
        self.files: List[dict] = []

    # progress / log
    def log(self, msg: str) -> None:
        self.job.log.append(f"{time.strftime('%H:%M:%S')}  {msg}")

    def progress(self, frac: float, stage: Optional[str] = None) -> None:
        if self.job.cancel_requested:
            raise JobCancelledError("Cancelled by user.")
        self.job.progress = float(max(0.0, min(1.0, frac)))
        if stage:
            self.job.stage = stage
            self.log(stage)

    # outputs
    def out_path(self, name: str) -> Path:
        return self.out / name

    def register(self, name: str, label: str) -> str:
        p = self.out / name
        self.files.append({"name": name, "label": label, "size": p.stat().st_size if p.exists() else 0})
        return name

    def spatial_panel(self, pid: str, title: str, coords: np.ndarray, patch0: float, values: np.ndarray,
                      channels: List[dict], thumb: str, scale: float, rgb: Optional[List[int]] = None,
                      default: int = 0) -> dict:
        """Save an N×C value matrix for lazy per-channel fetching, export QuPath GeoJSON, and return the panel descriptor."""
        values = np.asarray(values, dtype=np.float32)
        if values.ndim == 1:
            values = values[:, None]
        assert values.shape[0] == len(coords), (values.shape, len(coords))
        np.save(self.out / f"spatial_{pid}.npy", values)
        self._write_qupath_geojson(pid, coords, patch0, values, channels, default)
        return {"type": "spatial", "id": pid, "title": title,
                "coords": np.asarray(coords).astype(int).tolist(), "patch": float(patch0),
                "thumb": thumb, "scale": float(scale), "channels": channels, "rgb": rgb, "default": default}

    def _write_qupath_geojson(self, pid: str, coords: np.ndarray, patch0: float, values: np.ndarray,
                              channels: List[dict], default: int = 0) -> None:
        """Export a QuPath-compatible GeoJSON FeatureCollection for spatial patches."""
        # Palette matching frontend CAT colours
        cat_rgb = [
            [78, 121, 167], [225, 87, 89], [89, 161, 79], [242, 142, 43],
            [176, 122, 161], [118, 183, 178], [237, 201, 72], [255, 157, 167],
            [156, 117, 95], [47, 75, 124], [160, 203, 232], [140, 209, 125],
        ]
        s0 = float(patch0)
        def_ch = channels[default] if 0 <= default < len(channels) else (channels[0] if channels else None)
        max_props = min(len(channels), 16)
        features = []
        for idx, (x, y) in enumerate(np.asarray(coords, dtype=float)):
            poly = [[[x, y], [x + s0, y], [x + s0, y + s0], [x, y + s0], [x, y]]]
            props: Dict[str, Any] = {"objectType": "annotation"}
            if def_ch and def_ch.get("kind") == "categorical":
                cls_idx = int(round(float(values[idx, default])))
                labels = def_ch.get("labels") or []
                cls_name = labels[cls_idx] if 0 <= cls_idx < len(labels) else f"Class {cls_idx + 1}"
                props["classification"] = {"name": cls_name, "color": cat_rgb[cls_idx % len(cat_rgb)]}
            measurements = {}
            for c_idx in range(max_props):
                v = float(values[idx, c_idx])
                if np.isfinite(v):
                    measurements[channels[c_idx]["name"]] = round(v, 5)
            if measurements:
                props["measurements"] = measurements
            features.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": poly}, "properties": props})
        gj_name = f"qupath_{pid}.geojson"
        self.out_path(gj_name).write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
        self.register(gj_name, f"QuPath spatial annotations ({len(features)} patches, GeoJSON)")


class Job:
    def __init__(self, root: Path, model_id: str, task: str, params: dict, hf_token: Optional[str],
                 job_id: Optional[str] = None):
        self.id = job_id or uuid.uuid4().hex[:12]
        self.dir = root / self.id
        (self.dir / "input").mkdir(parents=True, exist_ok=True)
        self.model_id, self.task, self.params = model_id, task, params
        self.hf_token = hf_token
        self.inputs: Dict[str, Any] = {"tiles": [], "wsi": None}
        self.status = "queued"
        self.stage = "Waiting for the GPU"
        self.progress = 0.0
        self.log: List[str] = []
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.created = time.time()
        self.finished: Optional[float] = None
        self.cancel_requested = False

    def public(self, with_result: bool = True) -> dict:
        d = {"id": self.id, "model_id": self.model_id, "task": self.task, "status": self.status,
             "stage": self.stage, "progress": self.progress, "log": self.log[-200:], "error": self.error,
             "created": self.created, "finished": self.finished, "params": self.params}
        if with_result:
            d["result"] = self.result
        return d

    def persist(self) -> None:
        data = self.public(with_result=True)
        data["inputs"] = self.inputs
        (self.dir / "job.json").write_text(json.dumps(data, default=str), encoding="utf-8")

    @classmethod
    def from_disk(cls, root: Path, path: Path) -> Optional["Job"]:
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
            job = cls(root, d["model_id"], d["task"], d.get("params") or {}, None, job_id=d["id"])
            job.status = d.get("status", "error")
            if job.status in ("queued", "running"):
                job.status = "error"
                job.error = "Server restarted before this job finished."
            job.stage = d.get("stage", "")
            job.progress = float(d.get("progress", 0.0))
            job.log = list(d.get("log") or [])
            job.result = d.get("result")
            job.error = d.get("error") or job.error
            job.created = float(d.get("created", time.time()))
            job.finished = d.get("finished")
            job.inputs = d.get("inputs") or {"tiles": [], "wsi": None}
            return job
        except Exception:
            return None


@contextmanager
def hf_token_env(token: Optional[str]):
    """Expose a per-job HF token to huggingface_hub. Safe because jobs run one at a time."""
    if not token:
        yield
        return
    old = os.environ.get("HF_TOKEN")
    os.environ["HF_TOKEN"] = token
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("HF_TOKEN", None)
        else:
            os.environ["HF_TOKEN"] = old


class JobManager:
    def __init__(self, settings, registry: dict, dispatch: Callable[[JobContext, str], dict]):
        self.settings = settings
        self.models = {m["id"]: m for m in registry["models"]}
        self.dispatch = dispatch
        self.root = settings.work_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: Dict[str, Job] = {}
        self._load_persisted()
        self.q: "queue.Queue[Job]" = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def _load_persisted(self) -> None:
        for jf in sorted(self.root.glob("*/job.json")):
            job = Job.from_disk(self.root, jf)
            if job is not None:
                self.jobs[job.id] = job
        self._prune_old_jobs()

    def _prune_old_jobs(self) -> None:
        max_jobs = getattr(self.settings, "max_jobs_kept", 0) or 0
        if max_jobs <= 0 or len(self.jobs) <= max_jobs:
            return
        done = sorted([j for j in self.jobs.values() if j.status not in ("queued", "running")], key=lambda j: j.created)
        while len(self.jobs) > max_jobs and done:
            old = done.pop(0)
            self.jobs.pop(old.id, None)
            shutil.rmtree(old.dir, ignore_errors=True)

    def create(self, model_id: str, task: str, params: dict, hf_token: Optional[str]) -> Job:
        self._prune_old_jobs()
        job = Job(self.root, model_id, task, params, hf_token)
        self.jobs[job.id] = job
        return job

    def submit(self, job: Job) -> None:
        job.persist()
        self.q.put(job)

    def _worker(self) -> None:
        while True:
            job = self.q.get()
            if job.status == "cancelled" or job.cancel_requested:
                job.status = "cancelled"
                job.stage = "Cancelled"
                job.finished = time.time()
                job.persist()
                continue
            job.status = "running"
            job.stage = "Starting"
            ctx = JobContext(job, self.settings, self.models[job.model_id], self.settings.resolved_device())
            ctx.log(f"Model {job.model_id} · task {job.task} · device {ctx.device}" + (" · MOCK" if ctx.mock else ""))
            try:
                with hf_token_env(job.hf_token):
                    result = self.dispatch(ctx, job.task)
                result.setdefault("files", []).extend(ctx.files)
                result["mock"] = ctx.mock
                job.result = result
                job.status = "done"
                job.progress = 1.0
                job.stage = "Finished"
            except JobCancelledError as e:
                job.status = "cancelled"
                job.stage = "Cancelled"
                job.error = str(e)
                ctx.log("Job cancelled by user.")
            except Exception as e:  # surface the real error to the UI
                job.status = "error"
                job.error = f"{type(e).__name__}: {e}"
                ctx.log(traceback.format_exc())
            finally:
                job.finished = time.time()
                job.hf_token = None
                job.persist()
