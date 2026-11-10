#!/usr/bin/env bash
# Histology FM Portal — guided installer for macOS and Linux.
#
#   curl -fsSL https://<user>.github.io/<repo>/install/setup.sh | bash -s -- \
#        --repo https://github.com/<user>/<repo> --portal https://<user>.github.io/<repo>/
#
# Asks before every step. Installs nothing system-wide except Git (only if you agree). Python comes from
# uv (https://docs.astral.sh/uv) into your home folder — no admin rights needed. Re-running is safe.
set -euo pipefail

REPO=""; PORTAL=""; DIR="$HOME/histology-fm-portal"; YES=0; PORT=8000
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --portal) PORTAL="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    -y|--yes) YES=1; shift;;
    *) echo "Unknown option $1"; exit 2;;
  esac
done
[ -n "$REPO" ] && [ -n "$PORTAL" ] || { echo "Usage: setup.sh --repo https://github.com/<user>/<repo> --portal https://<user>.github.io/<repo>/"; exit 2; }
REPO="${REPO%/}"; REPO="${REPO%.git}"
ORIGIN="$(printf '%s' "$PORTAL" | sed -E 's#^(https?://[^/]+).*#\1#')"
export UV_SYSTEM_CERTS=true                         # trust the OS certificate store (university / NHS proxies)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

TTY=/dev/tty; [ -r /dev/tty ] || TTY=/dev/stdin
b=$(printf '\033[1m'); d=$(printf '\033[2m'); g=$(printf '\033[32m'); y=$(printf '\033[33m'); r=$(printf '\033[0m')
N=0
step() { N=$((N+1)); printf '\n%s[%s/9] %s%s\n' "$b" "$N" "$1" "$r"; }
ok()   { printf '  %s✓%s %s\n' "$g" "$r" "$1"; }
warn() { printf '  %s!%s %s\n' "$y" "$r" "$1"; }
ask()  { [ "$YES" = 1 ] && return 0; local a; printf '  %s [Y/n] ' "$1"; read -r a < "$TTY" || a=""; case "$a" in n|N|no|No) return 1;; *) return 0;; esac; }
askval() { local a; printf '  %s [%s]: ' "$1" "$2" >&2; if [ "$YES" = 1 ]; then echo "$2"; return; fi; read -r a < "$TTY" || a=""; echo "${a:-$2}"; }
askno() { [ "$YES" = 1 ] && return 1; local a; printf '  %s [y/N] ' "$1"; read -r a < "$TTY" || a=""; case "$a" in y|Y|yes|Yes) return 0;; *) return 1;; esac; }
openurl() {   # never fails: prints the link if no browser can be opened
  if [ "$(uname)" = "Darwin" ]; then open "$1" 2>/dev/null && return 0
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 && return 0; fi
  echo "  Open this in your browser: $1"; return 0; }

cat <<EOF
${b}Histology FM Portal — setup${r}
This will, asking before each step:
  1. choose an install folder          6. create a Python environment for the server
  2. check / install Git                7. write the server config (with a new portal key)
  3. install uv (Python manager)        8. Hugging Face token: y/n (optional, can skip)
  4. install Python 3.11 (via uv)       9. start the server in test mode and open the portal
  5. download the portal code           …then the portal's setup wizard takes over.
${d}Repository: $REPO
Portal:     $PORTAL${r}
EOF
ask "Continue?" || exit 0

step "Install folder"
DIR="$(askval "Install into" "$DIR")"
case "$DIR" in *OneDrive*|*Dropbox*|*iCloud*) warn "Cloud-synced folders can corrupt Python environments and fill your quota with weights — a local folder is safer.";; esac
mkdir -p "$DIR"; ok "$DIR"

step "Git"
if command -v git >/dev/null 2>&1; then ok "$(git --version)"
else
  warn "Git is not installed. TRIDENT's model extras (CONCH, MUSK, GigaPath) are installed from GitHub with Git."
  if ask "Install Git now?"; then
    if [ "$(uname)" = "Darwin" ]; then
      if command -v brew >/dev/null 2>&1; then brew install git
      else xcode-select --install || true; printf '  Finish the Command Line Tools installer window, then press Enter. '; read -r _ < "$TTY" || true; fi
    elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y git
    elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git
    elif command -v yum >/dev/null 2>&1; then sudo yum install -y git
    elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm git
    else warn "Unknown package manager — install Git yourself (https://git-scm.com/downloads)."; fi
  fi
  command -v git >/dev/null 2>&1 && ok "$(git --version)" || warn "Continuing without Git: the code will be downloaded as a ZIP."
fi

step "uv (installs and manages Python for you)"
if command -v uv >/dev/null 2>&1; then ok "$(uv --version)"
else
  ask "Install uv into your home folder (from astral.sh)?" || { echo "uv is needed to install Python. Stopping."; exit 1; }
  if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
    warn "The uv installer could not be downloaded; trying pip instead."
    python3 -m pip install --user uv
  fi
  hash -r; command -v uv >/dev/null 2>&1 || { echo "uv was installed but is not on PATH. Open a new terminal and re-run this command."; exit 1; }
  ok "$(uv --version)"
fi

step "Python 3.11"
uv python install 3.11 && ok "Python 3.11 ready ($(uv python find 3.11))"

step "Portal code"
if [ -d "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
  ask "Update the existing copy in $DIR?" && git -C "$DIR" pull --ff-only; ok "up to date"
elif [ -f "$DIR/backend/server.py" ]; then ok "already present in $DIR"
elif command -v git >/dev/null 2>&1; then git clone --depth 1 "$REPO.git" "$DIR.tmp" && cp -R "$DIR.tmp/." "$DIR/" && rm -rf "$DIR.tmp"; ok "cloned $REPO"
else
  curl -fsSL "$REPO/archive/refs/heads/main.zip" -o "$DIR/portal.zip"
  uv run --no-project --python 3.11 python - "$DIR/portal.zip" "$DIR" <<'PY'
import sys, zipfile, os
z = zipfile.ZipFile(sys.argv[1]); top = z.namelist()[0].split("/")[0]
for m in z.infolist():
    rel = m.filename[len(top) + 1:]
    if rel and not m.is_dir():
        t = os.path.join(sys.argv[2], rel); os.makedirs(os.path.dirname(t), exist_ok=True)
        open(t, "wb").write(z.read(m))
PY
  rm -f "$DIR/portal.zip"; ok "downloaded $REPO (ZIP)"
fi
B="$DIR/backend"

step "Server environment"
[ -x "$B/.venv/bin/python" ] || uv venv --python 3.11 "$B/.venv"
uv pip install --python "$B/.venv/bin/python" -r "$B/requirements-server.txt"
ok "environment at $B/.venv"

step "Server config"
PY="$B/.venv/bin/python"
KEY="$("$PY" - "$B/config.yaml" "$ORIGIN" <<'PY'
import sys, os, secrets, yaml
path, origin = sys.argv[1], sys.argv[2]
cfg = yaml.safe_load(open(path)) if os.path.exists(path) else {}
cfg = cfg or {}
origins = cfg.get("origins") or []
for o in [origin, "http://localhost:8080", "http://127.0.0.1:8080"]:
    if o not in origins: origins.append(o)
cfg["origins"] = origins
cfg.setdefault("portal_key", secrets.token_urlsafe(32))
cfg.setdefault("device", "auto")
cfg.setdefault("mock", True)            # test mode first; the wizard switches it off
cfg["setup_enabled"] = True             # lets the portal's wizard drive the remaining steps
open(path, "w").write("# Written by the Histology FM Portal installer. Safe to edit.\n" + yaml.safe_dump(cfg, sort_keys=False))
print(cfg["portal_key"])
PY
)"
ok "config.yaml written (portal key generated, guided setup on, test mode on)"

step "Hugging Face token (optional)"
# This step can never stop the installer: any problem here just skips to starting the server.
HF="$(mktemp "${TMPDIR:-/tmp}/fm-portal-hf.XXXXXX")"
cat > "$HF" <<'PY'
import os, sys
out = sys.stdout
sys.stderr = open(os.devnull, "w")   # keep library warnings out of the installer's output
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
def say(m): print("  " + m, file=out, flush=True)
def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        import truststore; truststore.inject_into_ssl()   # university / NHS proxies
    except Exception:
        pass
    from huggingface_hub import constants, get_token
    if mode == "check":                                    # offline: is a token already saved?
        return 0 if get_token() else 1
    tok = os.environ.get("HF_NEW_TOKEN", "").strip()
    if not tok.startswith("hf_"):
        say("That doesn't look like a token - Hugging Face tokens start with hf_."); return 1
    from huggingface_hub import login, whoami
    try:
        name = whoami(token=tok)["name"]
    except Exception as e:
        if getattr(getattr(e, "response", None), "status_code", None) in (401, 403):
            say("Hugging Face rejected that token (mistyped, expired or revoked?)."); return 1
        os.makedirs(os.path.dirname(constants.HF_TOKEN_PATH), exist_ok=True)
        with open(constants.HF_TOKEN_PATH, "w") as f: f.write(tok)
        say("Couldn't reach huggingface.co to check it (%s). Saved it anyway; the portal checks it later." % type(e).__name__)
        return 2
    login(token=tok, add_to_git_credential=False, skip_if_logged_in=False)
    say("Logged in to Hugging Face as %s." % name); return 0
try:
    sys.exit(main())
except SystemExit:
    raise
except BaseException as e:
    say("Couldn't save the token (%s). You can add it later in the portal." % type(e).__name__); sys.exit(3)
PY
LATER="skipped — add it later in the portal (setup wizard, 'Hugging Face' step)"
echo "  Gated models need a free Hugging Face account and a READ token. Skipping is fine."
if "$PY" "$HF" check >/dev/null 2>&1; then
  if askno "A Hugging Face token is already saved on this computer. Replace it?"; then WANT=1; else WANT=0; ok "keeping the saved token"; fi
else
  if askno "Add your Hugging Face token now? (y = paste it, n = skip and start the server)"; then WANT=1; else WANT=0; ok "$LATER"; fi
fi
if [ "$WANT" = 1 ]; then
  if askno "Do you need to create a free Hugging Face account first?"; then openurl "https://huggingface.co/join"; fi
  echo "  Make a READ token at https://huggingface.co/settings/tokens — never type your password here."
  if askno "Open the token page in your browser now?"; then openurl "https://huggingface.co/settings/tokens"; fi
  DONE=0; i=0
  while [ "$DONE" = 0 ] && [ "$i" -lt 3 ]; do
    i=$((i+1))
    printf '  Paste the token and press Enter (it stays hidden; Enter on its own skips): '
    TOKEN=""; stty -echo < "$TTY" 2>/dev/null || true; read -r TOKEN < "$TTY" || TOKEN=""; stty echo < "$TTY" 2>/dev/null || true; echo
    TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
    if [ -z "$TOKEN" ]; then ok "$LATER"; DONE=1; break; fi
    RC=0; HF_NEW_TOKEN="$TOKEN" "$PY" "$HF" save || RC=$?
    case "$RC" in
      0) ok "token saved"; DONE=1;;
      2) warn "token saved, not yet verified"; DONE=1;;
      3) DONE=1;;
      *) if ! askno "Try another token?"; then ok "$LATER"; DONE=1; fi;;
    esac
  done
  [ "$DONE" = 1 ] || ok "$LATER"
  unset TOKEN
fi
rm -f "$HF"

step "Start the server and open the portal"
URL="${PORTAL%/}/#setup&url=http://127.0.0.1:${PORT}&key=${KEY}"
echo "  The server runs in this window — keep it open. Ctrl+C stops it; restart later with:"
echo "    bash \"$B/start_server.sh\""
ask "Start now?" || exit 0
( sleep 3; openurl "$URL" ) &
cd "$B" && PORT="$PORT" exec bash start_server.sh
