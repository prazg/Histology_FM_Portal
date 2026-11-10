# Histology FM Portal — guided installer for Windows (PowerShell 5.1 or 7).
#
#   powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm 'https://<user>.github.io/<repo>/install/setup.ps1'))) -Repo 'https://github.com/<user>/<repo>' -Portal 'https://<user>.github.io/<repo>/'"
#
# Asks before every step. Git comes from winget (only if you agree). Python comes from uv
# (https://docs.astral.sh/uv) into your user profile — no admin rights needed. Re-running is safe.
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Portal,
  [string]$Dir = (Join-Path $HOME "histology-fm-portal"),
  [int]$Port = 8000,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = $Repo.TrimEnd("/") -replace "\.git$", ""
$Origin = ([Uri]$Portal).GetLeftPart([UriPartial]::Authority)
$env:UV_SYSTEM_CERTS = "true"     # trust the Windows certificate store (university / NHS proxies)
$env:Path = "$HOME\.local\bin;$env:Path"
$script:N = 0

function Step($t) { $script:N++; Write-Host ""; Write-Host "[$($script:N)/9] $t" -ForegroundColor White }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  !   $t" -ForegroundColor Yellow }
function Ask($q)  { if ($Yes) { return $true }; $a = Read-Host "  $q [Y/n]"; return -not ($a -match '^(n|no)$') }
function AskNo($q) { if ($Yes) { return $false }; $a = Read-Host "  $q [y/N]"; return ($a -match '^(y|yes)$') }
function AskVal($q, $def) { if ($Yes) { return $def }; $a = Read-Host "  $q [$def]"; if ($a) { return $a } else { return $def } }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Run($exe, [string[]]$argv) { & $exe @argv; if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE)" } }

Write-Host "Histology FM Portal - setup" -ForegroundColor White
Write-Host @"
This will, asking before each step:
  1. choose an install folder          6. create a Python environment for the server
  2. check / install Git                7. write the server config (with a new portal key)
  3. install uv (Python manager)        8. connect your Hugging Face account (optional now)
  4. install Python 3.11 (via uv)       9. start the server in test mode and open the portal
  5. download the portal code           ...then the portal's setup wizard takes over.
Repository: $Repo
Portal:     $Portal
"@
if (-not (Ask "Continue?")) { return }

Step "Install folder"
$Dir = AskVal "Install into" $Dir
if ($Dir -match "OneDrive|Dropbox|iCloud") { Warn "Cloud-synced folders can corrupt Python environments and fill your quota with weights - a local folder is safer." }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null; Ok $Dir

Step "Git"
if (Have git) { Ok (git --version) }
else {
  Warn "Git is not installed. TRIDENT's model extras (CONCH, MUSK, GigaPath) are installed from GitHub with Git."
  if ((Ask "Install Git now with winget?") -and (Have winget)) {
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path"
  } elseif (-not (Have winget)) { Warn "winget is not available - install Git from https://git-scm.com/download/win and re-run." }
  if (Have git) { Ok (git --version) } else { Warn "Continuing without Git: the code will be downloaded as a ZIP." }
}

Step "uv (installs and manages Python for you)"
if (Have uv) { Ok (uv --version) }
else {
  if (-not (Ask "Install uv into your user profile (from astral.sh)?")) { Write-Host "uv is needed to install Python. Stopping."; return }
  powershell -ExecutionPolicy ByPass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$HOME\.local\bin;$env:Path"
  if (-not (Have uv)) { Write-Host "uv was installed but is not on PATH. Open a new PowerShell window and re-run this command."; return }
  Ok (uv --version)
}

Step "Python 3.11"
Run uv @("python", "install", "3.11"); Ok "Python 3.11 ready"

Step "Portal code"
if ((Test-Path (Join-Path $Dir ".git")) -and (Have git)) {
  if (Ask "Update the existing copy in $Dir?") { Run git @("-C", $Dir, "pull", "--ff-only") }; Ok "up to date"
} elseif (Test-Path (Join-Path $Dir "backend\server.py")) { Ok "already present in $Dir" }
elseif (Have git) {
  $tmp = "$Dir.tmp"; Run git @("clone", "--depth", "1", "$Repo.git", $tmp)
  Copy-Item -Path (Join-Path $tmp "*") -Destination $Dir -Recurse -Force
  Copy-Item -Path (Join-Path $tmp ".git") -Destination $Dir -Recurse -Force
  Remove-Item -Recurse -Force $tmp; Ok "cloned $Repo"
} else {
  $zip = Join-Path $env:TEMP "fm-portal.zip"; $ex = Join-Path $env:TEMP "fm-portal-x"
  Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip
  if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
  Expand-Archive $zip -DestinationPath $ex
  $top = Get-ChildItem $ex | Select-Object -First 1
  Copy-Item -Path (Join-Path $top.FullName "*") -Destination $Dir -Recurse -Force
  Remove-Item -Recurse -Force $ex, $zip; Ok "downloaded $Repo (ZIP)"
}
$B = Join-Path $Dir "backend"
$Py = Join-Path $B ".venv\Scripts\python.exe"

Step "Server environment"
if (-not (Test-Path $Py)) { Run uv @("venv", "--python", "3.11", (Join-Path $B ".venv")) }
Run uv @("pip", "install", "--python", $Py, "-r", (Join-Path $B "requirements-server.txt"))
Ok "environment at $B\.venv"

Step "Server config"
$cfgScript = @'
import sys, os, secrets, yaml
path, origin = sys.argv[1], sys.argv[2]
cfg = (yaml.safe_load(open(path)) if os.path.exists(path) else {}) or {}
origins = cfg.get("origins") or []
for o in [origin, "http://localhost:8080", "http://127.0.0.1:8080"]:
    if o not in origins: origins.append(o)
cfg["origins"] = origins
cfg.setdefault("portal_key", secrets.token_urlsafe(32))
cfg.setdefault("device", "auto")
cfg.setdefault("mock", True)
cfg["setup_enabled"] = True
open(path, "w").write("# Written by the Histology FM Portal installer. Safe to edit.\n" + yaml.safe_dump(cfg, sort_keys=False))
print(cfg["portal_key"])
'@
$cfgFile = Join-Path $env:TEMP "fm-portal-cfg.py"; Set-Content -Path $cfgFile -Value $cfgScript -Encoding UTF8
$Key = (& $Py $cfgFile (Join-Path $B "config.yaml") $Origin | Select-Object -Last 1).Trim()
Remove-Item $cfgFile
Ok "config.yaml written (portal key generated, guided setup on, test mode on)"

Step "Hugging Face account"
Write-Host "  Many models are 'gated': you request access on each model's page, and the server downloads them with your token."
& $Py -c "from huggingface_hub import get_token, whoami; t=get_token(); print('  logged in as', whoami(token=t)['name']) if t else exit(1)" 2>$null
if ($LASTEXITCODE -eq 0) { Ok "already logged in" }
else {
  if (AskNo "Do you need to create a free Hugging Face account first?") { Start-Process "https://huggingface.co/join" }
  Write-Host "  Create a READ token at https://huggingface.co/settings/tokens (never type your password here)."
  $tok = ""
  if (-not $Yes) {
    $sec = Read-Host "  Paste the token now, or press Enter to do it later in the portal" -AsSecureString
    $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ($tok) {
    $env:HF_NEW_TOKEN = $tok
    & $Py -c "import os; from huggingface_hub import login, whoami; t=os.environ['HF_NEW_TOKEN']; print('  logged in as', whoami(token=t)['name']); login(token=t)"
    if ($LASTEXITCODE -eq 0) { Ok "token saved" } else { Warn "That token was rejected - you can add it later in the portal." }
    Remove-Item Env:\HF_NEW_TOKEN
  }
}

Step "Start the server and open the portal"
$Url = "$($Portal.TrimEnd('/'))/#setup&url=http://127.0.0.1:$Port&key=$Key"
Write-Host "  The server runs in this window - keep it open. Ctrl+C stops it; restart later with:"
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$B\start_server.ps1`""
if (-not (Ask "Start now?")) { return }
Start-Job -ScriptBlock { param($u) Start-Sleep 4; Start-Process $u } -ArgumentList $Url | Out-Null
Set-Location $B
& (Join-Path $B "start_server.ps1") -Port $Port -Python $Py
