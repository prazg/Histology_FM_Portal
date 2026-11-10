# Start the Histology FM Portal backend (Windows PowerShell).
#   .\start_server.ps1           real models
#   .\start_server.ps1 -Mock     try the portal without weights
# If scripts are blocked:  powershell -ExecutionPolicy Bypass -File .\start_server.ps1
param([switch]$Mock, [int]$Port = 8000, [string]$Python = "")
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
if (-not $Python) { $Python = if (Test-Path ".venv\Scripts\python.exe") { ".venv\Scripts\python.exe" } else { "python" } }

$check = @'
import importlib.util as u, sys
need = ["fastapi", "uvicorn", "yaml", "h5py", "huggingface_hub", "numpy", "PIL", "truststore"]
missing = [m for m in need if u.find_spec(m) is None] + ([] if (u.find_spec("python_multipart") or u.find_spec("multipart")) else ["python-multipart"])
sys.exit(1 if missing else 0)
'@
& $Python -c $check
if ($LASTEXITCODE -ne 0) { & $Python -m pip install -r requirements-server.txt }

if (-not (Test-Path "config.yaml")) { Write-Host "Note: no config.yaml - using defaults. Copy config.example.yaml to set a portal key, origins and slide folders." }
if ($Mock) { $env:PORTAL_MOCK = "1" }
& $Python check_setup.py --short
Write-Host "Open the portal -> Connect -> http://127.0.0.1:$Port   (Ctrl+C stops the server)"
# Exit code 3 = the portal's setup wizard asked for a restart (to load newly installed packages).
while ($true) {
  & $Python -m uvicorn server:app --host 127.0.0.1 --port $Port
  if ($LASTEXITCODE -ne 3) { break }
  Write-Host "Restarting the server to load newly installed packages..."
}
