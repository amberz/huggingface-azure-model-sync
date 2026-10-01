#!/usr/bin/env bash
# Mirror a Hugging Face model repository into the blob container using
# server-side copy: Azure Storage pulls each file directly from Hugging Face,
# nothing is downloaded to this machine.
#
# Usage: ./scripts/copy_hf_model.sh <repo_id> [revision]
#   e.g. ./scripts/copy_hf_model.sh openai-community/gpt2
# Gated/private repos: export HF_TOKEN=<token> first.
#
# Files land in models/base/<repo_id>/ with metadata hf_repo / hf_revision.
# Re-running skips files already copied at the same revision.
source "$(dirname "$0")/common.sh"

REPO="${1:?usage: $0 <repo_id> [revision]}"
REV="${2:-main}"
HF="https://huggingface.co"
PREFIX="models/base/$REPO"
AUTH=()
[[ -n "${HF_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $HF_TOKEN")

SHA=$(curl -fsS ${AUTH[@]+"${AUTH[@]}"} "$HF/api/models/$REPO/revision/$REV" | jq -r .sha)
log "Copying $REPO@${SHA:0:7} -> $STORAGE_ACCOUNT/$BLOB_CONTAINER/$PREFIX/"

# A fresh role assignment can take minutes to reach the data plane.
for attempt in $(seq 1 30); do
  az storage blob list --auth-mode login --account-name "$STORAGE_ACCOUNT" -c "$BLOB_CONTAINER" \
    --num-results 1 -o none 2>/dev/null && break
  [[ $attempt == 30 ]] && { echo "No blob data access after 10 minutes" >&2; exit 1; }
  echo "  waiting for blob data access (role assignment propagating)..."
  sleep 20
done

# path<TAB>size for every file at that commit.
FILES=$(curl -fsS ${AUTH[@]+"${AUTH[@]}"} "$HF/api/models/$REPO/tree/$SHA?recursive=true" |
  jq -r '.[] | select(.type == "file") | [.path, (.lfs.size // .size)] | @tsv')

list_blobs() {
  az storage blob list --auth-mode login --account-name "$STORAGE_ACCOUNT" -c "$BLOB_CONTAINER" \
    --prefix "$PREFIX/" --include cm --num-results '*' \
    --query "[].[name, properties.contentLength, properties.copy.status, metadata.hf_revision]" -o tsv
}

EXISTING=$(list_blobs)
started=0 skipped=0
while IFS=$'\t' read -r path size; do
  blob="$PREFIX/$path"
  if grep -qF "$blob"$'\t'"$size"$'\tsuccess\t'"$SHA" <<<"$EXISTING"; then
    skipped=$((skipped + 1))
    continue
  fi
  # Resolve redirects to the CDN URL; Azure's copy does not follow them.
  src=$(curl -fsSIL ${AUTH[@]+"${AUTH[@]}"} -o /dev/null -w '%{url_effective}' "$HF/$REPO/resolve/$SHA/$path")
  az storage blob copy start --auth-mode login --account-name "$STORAGE_ACCOUNT" \
    --destination-container "$BLOB_CONTAINER" --destination-blob "$blob" --source-uri "$src" \
    --metadata hf_repo="$REPO" hf_revision="$SHA" -o none
  printf '  started  %10s bytes  %s\n' "$size" "$path"
  started=$((started + 1))
done <<<"$FILES"
echo "Started $started copies, skipped $skipped already present."

log "Waiting for copies to finish"
total=$(wc -l <<<"$FILES" | tr -d ' ')
while :; do
  STATE=$(list_blobs)
  pending=$(awk -F'\t' '$3 == "pending"' <<<"$STATE" | wc -l | tr -d ' ')
  failed=$(awk -F'\t' '$3 == "failed" || $3 == "aborted"' <<<"$STATE" | cut -f1)
  if [[ -n "$failed" ]]; then
    echo "Failed copies:" >&2
    echo "$failed" >&2
    exit 1
  fi
  [[ "$pending" == "0" ]] && break
  echo "  $pending of $total still copying..."
  sleep 10
done

log "Verifying sizes"
bad=0
while IFS=$'\t' read -r path size; do
  if ! grep -qF "$PREFIX/$path"$'\t'"$size"$'\t' <<<"$STATE"; then
    echo "  size mismatch or missing: $path" >&2
    bad=1
  fi
done <<<"$FILES"
[[ $bad == 0 ]] || exit 1
echo "All $total files copied and verified."
echo "https://$STORAGE_ACCOUNT.blob.core.windows.net/$BLOB_CONTAINER/$PREFIX/"
