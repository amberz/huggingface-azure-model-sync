#!/usr/bin/env bash
# Runs inside ACI: install Hugging Face transformers, then train.
set -euo pipefail

echo "==> Installing PyTorch (CPU) and Hugging Face libraries"
python -m pip install --no-cache-dir --quiet --upgrade pip
python -m pip install --no-cache-dir --quiet torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install --no-cache-dir --quiet transformers datasets accelerate azure-identity azure-storage-blob
python -c "import transformers, torch; print('transformers', transformers.__version__, '| torch', torch.__version__)"

echo "==> Training"
exec python -u /app/train.py
