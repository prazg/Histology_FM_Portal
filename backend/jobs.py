"""Single-GPU job queue: one worker thread runs jobs in submission order."""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np


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
        """Save an N×C value matrix for lazy per-channel fetching and return the panel descriptor."""
        values = np.asarray(values, dtype=np.float32)
        if values.ndim == 1:
            values = values[:, None]
        assert values.shape[0] == len(coords), (values.shape, len(coords))
        np.save(self.out / f"spatial_{pid}.npy", values)
        return {"type": "spatial", "id": pid, "title": title,
                "coords": np.asarray(coords).astype(int).tolist(), "patch": float(patch0),
                "thumb": thumb, "scale": float(scale), "channels": channels, "rgb": rgb, "default": default}


class Job:
    def __init__(self, root: Path, model_id: str, task: str, params: dict, hf_token: Optional[str]):
        self.id = uuid.uuid4().hex[:12]
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

    def public(self, with_result: bool = True) -> dict:
        d = {"id": self.id, "model_id": self.model_id, "task": self.task, "status": self.status,
             "stage": self.stage, "progress": self.progress, "log": self.log[-200:], "error": self.error,
             "created": self.created, "finished": self.finished, "params": self.params}
        if with_result:
            d["result"] = self.result
        return d

    def persist(self) -> None:
        (self.dir / "job.json").write_text(json.dumps(self.public(), default=str), encoding="utf-8")


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


def _reset_peak(device: str) -> None:
    if device.startswith("cuda"):
        try:
            import torch
            torch.cuda.reset_peak_memory_stats(device)
        except Exception:
            pass


def _peak_gb(device: str) -> Optional[float]:
    if not device.startswith("cuda"):
        return None
    try:
        import torch
        return round(torch.cuda.max_memory_allocated(device) / 1e9, 2)
    except Exception:
        return None


class PerfLog:
    """Measured speed per model × task × device, so the portal can show real numbers instead of guesses."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    @staticmethod
    def _items(job: "Job", result: dict) -> Optional[int]:
        if job.inputs.get("tiles"):
            return len(job.inputs["tiles"])
        for p in result.get("panels", []):
            if p.get("type") == "spatial":
                return len(p["coords"])
        for s in result.get("summary", []):
            if s.get("label") in ("Patches", "Spots") and isinstance(s.get("value"), int):
                return s["value"]
        return None

    def record(self, job, ctx, result, seconds: float, peak_gb: Optional[float]) -> None:
        if ctx.mock:
            return
        gpu = None
        if ctx.device.startswith("cuda"):
            try:
                import torch
                gpu = torch.cuda.get_device_name(ctx.device)
            except Exception:
                pass
        row = {"t": time.time(), "model_id": job.model_id, "task": job.task, "device": "cuda" if gpu else "cpu",
               "gpu": gpu, "items": self._items(job, result), "seconds": round(seconds, 2), "peak_vram_gb": peak_gb}
        with self.lock, self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def summary(self) -> dict:
        """{model_id: {task: {device: {runs, items_per_s (median), peak_vram_gb (max), gpu}}}}"""
        rows = []
        if self.path.exists():
            for ln in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    rows.append(json.loads(ln))
                except json.JSONDecodeError:
                    pass
        out: dict = {}
        for r in rows:
            d = out.setdefault(r["model_id"], {}).setdefault(r["task"], {}).setdefault(r["device"], {"rates": [], "peak": [], "gpu": r.get("gpu")})
            if r.get("items") and r["seconds"] > 0:
                d["rates"].append(r["items"] / r["seconds"])
            if r.get("peak_vram_gb") is not None:
                d["peak"].append(r["peak_vram_gb"])
        for m in out.values():
            for t in m.values():
                for dev, d in list(t.items()):
                    rates = sorted(d.pop("rates"))
                    peaks = d.pop("peak")
                    d["runs"] = len(rates)
                    d["items_per_s"] = round(rates[len(rates) // 2], 3) if rates else None
                    d["peak_vram_gb"] = max(peaks) if peaks else None
        return out


class JobManager:
    def __init__(self, settings, registry: dict, dispatch: Callable[[JobContext, str], dict]):
        self.settings = settings
        self.models = {m["id"]: m for m in registry["models"]}
        self.dispatch = dispatch
        self.root = settings.work_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: Dict[str, Job] = {}
        self.q: "queue.Queue[Job]" = queue.Queue()
        self.perf = PerfLog(settings.work_dir / "perf.jsonl")
        threading.Thread(target=self._worker, daemon=True).start()

    def create(self, model_id: str, task: str, params: dict, hf_token: Optional[str]) -> Job:
        job = Job(self.root, model_id, task, params, hf_token)
        self.jobs[job.id] = job
        return job

    def submit(self, job: Job) -> None:
        job.persist()
        self.q.put(job)

    def _worker(self) -> None:
        while True:
            job = self.q.get()
            if job.status == "cancelled":
                continue
            job.status = "running"
            job.stage = "Starting"
            ctx = JobContext(job, self.settings, self.models[job.model_id], self.settings.resolved_device())
            ctx.log(f"Model {job.model_id} · task {job.task} · device {ctx.device}" + (" · MOCK" if ctx.mock else ""))
            t0 = time.time()
            _reset_peak(ctx.device)
            try:
                with hf_token_env(job.hf_token):
                    result = self.dispatch(ctx, job.task)
                result.setdefault("files", []).extend(ctx.files)
                result["mock"] = ctx.mock
                self.perf.record(job, ctx, result, time.time() - t0, _peak_gb(ctx.device))
                job.result = result
                job.status = "done"
                job.progress = 1.0
                job.stage = "Finished"
            except Exception as e:  # surface the real error to the UI
                job.status = "error"
                job.error = f"{type(e).__name__}: {e}"
                ctx.log(traceback.format_exc())
            finally:
                job.finished = time.time()
                job.hf_token = None
                job.persist()
