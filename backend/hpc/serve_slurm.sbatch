#!/bin/bash
# Run the portal backend on a GPU node and reach it from your laptop through an SSH tunnel.
#   cd fm_portal/backend && sbatch hpc/serve_slurm.sbatch
# EDIT the lines marked CHANGE_ME for your cluster (partition names, GPU request syntax, modules/env).
#SBATCH --job-name=fm-portal
#SBATCH --partition=CHANGE_ME_gpu_partition
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=08:00:00
#SBATCH --output=fm-portal-%j.log

# CHANGE_ME: load your environment, e.g.
# module load CUDA
# source ~/miniconda3/etc/profile.d/conda.sh && conda activate pathology

cd "${SLURM_SUBMIT_DIR:-$(dirname "$0")/..}"
PORT=${PORT:-8000}
# Point HF_HOME at shared lab storage so each model is downloaded once for the whole group.
export HF_HOME=${HF_HOME:-$HOME/.cache/huggingface}

# A compute node is shared: refuse to start without a portal key.
python -c "from config import load_settings; import sys; sys.exit(0 if load_settings().portal_key else 1)" || {
  echo "Set portal_key in backend/config.yaml before running on a shared node."; exit 1; }

echo "=================================================================="
echo "Server starting on $(hostname):${PORT}"
echo "On your laptop run (replace LOGIN with your cluster's login host):"
echo "  ssh -N -L ${PORT}:$(hostname):${PORT} ${USER}@LOGIN"
echo "then open the portal -> Connect -> http://127.0.0.1:${PORT}"
echo "=================================================================="
python check_setup.py --short || true
exec python -m uvicorn server:app --host 0.0.0.0 --port "${PORT}"
