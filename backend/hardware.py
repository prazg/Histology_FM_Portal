"""Detect the hardware of the machine the backend runs on (where models actually execute).

Reports CPU, RAM, CUDA GPUs (name, total/free memory), Apple MPS, and the most common setup problem:
an NVIDIA GPU is present but PyTorch is a CPU-only build, so the GPU sits unused."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from typing import Optional


def _ram_gb() -> tuple[Optional[float], Optional[float]]:
    """(total, available) in GB, without requiring psutil."""
    try:
        import psutil
        vm = psutil.virtual_memory()
        return vm.total / 1e9, vm.available / 1e9
    except ImportError:
        pass
    sysname = platform.system()
    try:
        if sysname == "Linux":
            info = {}
            with open("/proc/meminfo") as f:
                for ln in f:
                    k, v = ln.split(":", 1)
                    info[k] = int(v.strip().split()[0]) * 1024
            return info["MemTotal"] / 1e9, info.get("MemAvailable", info.get("MemFree", 0)) / 1e9
        if sysname == "Windows":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return ms.ullTotalPhys / 1e9, ms.ullAvailPhys / 1e9
        if sysname == "Darwin":
            total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout)
            return total / 1e9, None
    except Exception:
        pass
    return None, None


def _nvidia_smi() -> list[dict]:
    """GPUs as the NVIDIA driver sees them — independent of whether PyTorch can use them."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total,memory.free,driver_version",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    gpus = []
    for ln in out.strip().splitlines():
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) >= 4:
            gpus.append({"name": parts[0], "vram_total_gb": round(float(parts[1]) / 1024, 2),
                         "vram_free_gb": round(float(parts[2]) / 1024, 2), "driver": parts[3]})
    return gpus


def detect(hf_cache: Optional[str] = None) -> dict:
    total, avail = _ram_gb()
    hw = {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu_cores": os.cpu_count(),
        "cpu_name": platform.processor() or platform.machine(),
        "ram_total_gb": round(total, 1) if total else None,
        "ram_available_gb": round(avail, 1) if avail else None,
        "torch": None, "torch_cuda": None, "cuda_available": False, "mps_available": False,
        "gpus": [], "driver_gpus": _nvidia_smi(), "warnings": [],
    }
    try:
        import torch
        hw["torch"] = torch.__version__
        hw["torch_cuda"] = torch.version.cuda          # None on CPU-only builds
        hw["cuda_available"] = torch.cuda.is_available()
        if hw["cuda_available"]:
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                g = {"index": i, "name": p.name, "vram_total_gb": round(p.total_memory / 1e9, 2),
                     "capability": f"{p.major}.{p.minor}"}
                try:
                    free, _ = torch.cuda.mem_get_info(i)
                    g["vram_free_gb"] = round(free / 1e9, 2)
                except Exception:
                    pass
                hw["gpus"].append(g)
        mps = getattr(torch.backends, "mps", None)
        hw["mps_available"] = bool(mps and mps.is_available())
    except ImportError:
        hw["warnings"].append("PyTorch is not installed on the server — install it before running real models.")

    if hw["driver_gpus"] and not hw["cuda_available"]:
        name = hw["driver_gpus"][0]["name"]
        if hw["torch"] and not hw["torch_cuda"]:
            hw["warnings"].append(f"{name} is installed, but PyTorch {hw['torch']} is a CPU-only build, so models run on the CPU. "
                                  "Reinstall PyTorch with CUDA (pytorch.org/get-started/locally) to use the GPU.")
        elif hw["torch"]:
            hw["warnings"].append(f"{name} is installed, but PyTorch cannot use it (CUDA {hw['torch_cuda']} build). "
                                  "Check that the NVIDIA driver supports this CUDA version.")
    if hw["mps_available"] and not hw["cuda_available"]:
        hw["warnings"].append("Apple GPU (MPS) detected. The portal runs models on the CPU here; MPS support in TRIDENT and the "
                              "model repos has not been tested.")
    if hf_cache:
        try:
            os.makedirs(hf_cache, exist_ok=True)
            du = shutil.disk_usage(hf_cache)
            hw["weights_disk_free_gb"] = round(du.free / 1e9, 1)
        except Exception:
            pass
    return hw


def best_vram_gb(hw: dict) -> Optional[float]:
    return max((g["vram_total_gb"] for g in hw.get("gpus", [])), default=None)
