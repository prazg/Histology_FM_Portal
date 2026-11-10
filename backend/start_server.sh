#!/usr/bin/env bash
# Start the Histology FM Portal backend.   ./start_server.sh        (MOCK=1 ./start_server.sh to try without weights)
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"; command -v "$PY" >/dev/null 2>&1 || PY=python
"$PY" - <<'PY' || "$PY" -m pip install -r requirements-server.txt
import importlib.util as u, sys
need = ["fastapi", "uvicorn", "yaml", "h5py", "huggingface_hub", "numpy", "PIL"]
missing = [m for m in need if u.find_spec(m) is None] + ([] if (u.find_spec("python_multipart") or u.find_spec("multipart")) else ["python-multipart"])
sys.exit(1 if missing else 0)
PY
[ -f config.yaml ] || echo "Note: no config.yaml — using defaults. Copy config.example.yaml to set a portal key, origins and slide folders."
[ "${MOCK:-0}" = "1" ] && export PORTAL_MOCK=1
"$PY" check_setup.py --short || true
echo "Open the portal → Connect → http://${HOST:-127.0.0.1}:${PORT:-8000}"
exec "$PY" -m uvicorn server:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
