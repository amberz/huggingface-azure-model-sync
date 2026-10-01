#!/usr/bin/env bash
# Step 1-2: resource group, storage account, blob container.
source "$(dirname "$0")/common.sh"

ensure_provider Microsoft.Storage

log "Resource group $RESOURCE_GROUP ($LOCATION)"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

log "Storage account $STORAGE_ACCOUNT"
if az storage account show -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  echo "Already exists"
else
  # Entra ID only (no shared keys), private blobs, TLS 1.2+.
  az storage account create \
    -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --access-tier Hot \
    --https-only true --min-tls-version TLS1_2 \
    --allow-blob-public-access false --allow-shared-key-access false \
    -o none
fi

# Soft delete protects model weights / checkpoints from accidental deletion.
az storage account blob-service-properties update \
  --account-name "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" \
  --enable-delete-retention true --delete-retention-days 7 \
  --enable-container-delete-retention true --container-delete-retention-days 7 \
  -o none

log "Blob container $BLOB_CONTAINER"
# Control-plane create: works without data-plane RBAC.
az storage container-rm create \
  --storage-account "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" \
  -n "$BLOB_CONTAINER" --public-access off -o none

log "Grant current user data access (for az storage blob ... --auth-mode login)"
SA_ID=$(az storage account show -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" --query id -o tsv)
ME=$(signed_in_object_id)
ensure_role "$ME" User "Storage Blob Data Contributor" "$SA_ID"

log "Done"
echo "Blob endpoint: https://$STORAGE_ACCOUNT.blob.core.windows.net/$BLOB_CONTAINER"
