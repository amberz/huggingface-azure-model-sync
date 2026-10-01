#!/usr/bin/env bash
# Sourced by the other scripts: loads config, selects subscription,
# and resolves the storage account name.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/.state.env"

# shellcheck source=../config.env
source "$ROOT_DIR/config.env"
# Use the persisted generated name only when none was given.
if [[ -z "$STORAGE_ACCOUNT" && -f "$STATE_FILE" ]]; then
  source "$STATE_FILE"
fi

if [[ -n "$SUBSCRIPTION_ID" ]]; then
  # The local subscription cache can lag behind new access; refresh once.
  az account set --subscription "$SUBSCRIPTION_ID" 2>/dev/null || {
    az account list --refresh -o none
    az account set --subscription "$SUBSCRIPTION_ID"
  }
fi

if [[ -z "$STORAGE_ACCOUNT" ]]; then
  STORAGE_ACCOUNT="sthfmodel$(openssl rand -hex 4)"
  echo "STORAGE_ACCOUNT=\"$STORAGE_ACCOUNT\"" >> "$STATE_FILE"
fi

log() { printf '\n==> %s\n' "$*"; }

# Register a resource provider in the subscription if needed.
ensure_provider() {
  local state
  state=$(az provider show -n "$1" --query registrationState -o tsv)
  if [[ "$state" != "Registered" ]]; then
    echo "Registering resource provider $1 ..."
    az provider register -n "$1" --wait -o none
  fi
}

# Object id of the signed-in user, read from the ARM token's `oid` claim.
# Avoids `az ad signed-in-user show`, which needs a Graph token that
# conditional access token protection may block.
signed_in_object_id() {
  az account get-access-token --query accessToken -o tsv |
    python3 -c 'import sys,json,base64; p=sys.stdin.read().split(".")[1]; print(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))["oid"])'
}

# Grant a role on a scope only if it is not already assigned.
ensure_role() {
  local principal_id="$1" principal_type="$2" role="$3" scope="$4"
  local existing
  # Filter by principalId client-side: --assignee would trigger a Graph lookup.
  existing=$(az role assignment list --role "$role" --scope "$scope" --fill-principal-name false \
    --query "length([?principalId=='$principal_id'])" -o tsv)
  if [[ "$existing" == "0" ]]; then
    az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type "$principal_type" \
      --role "$role" --scope "$scope" -o none
    echo "Assigned '$role' to $principal_type $principal_id"
  else
    echo "'$role' already assigned to $principal_type $principal_id"
  fi
}
