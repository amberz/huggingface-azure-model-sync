#!/usr/bin/env bash
# Step 3-6: managed identity + Azure Container Instance that installs
# transformers, trains, and checkpoints to blob storage.
source "$(dirname "$0")/common.sh"

ensure_provider Microsoft.ManagedIdentity
ensure_provider Microsoft.ContainerInstance

SA_ID=$(az storage account show -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" --query id -o tsv)

log "User-assigned managed identity $IDENTITY_NAME"
# ARM REST instead of `az identity create`, which requests a token that
# conditional access token protection blocks.
SUB_ID=$(az account show --query id -o tsv)
ID_JSON=$(az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUB_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$IDENTITY_NAME?api-version=2023-01-31" \
  --body "{\"location\":\"$ACI_LOCATION\"}" -o json)
ID_RESOURCE_ID=$(jq -r .id <<<"$ID_JSON")
ID_CLIENT_ID=$(jq -r .properties.clientId <<<"$ID_JSON")
ID_PRINCIPAL_ID=$(jq -r .properties.principalId <<<"$ID_JSON")
ensure_role "$ID_PRINCIPAL_ID" ServicePrincipal "Storage Blob Data Contributor" "$SA_ID"

log "Container group $ACI_NAME"
if az container show -n "$ACI_NAME" -g "$RESOURCE_GROUP" -o none 2>/dev/null; then
  echo "Deleting previous container group"
  az container delete -n "$ACI_NAME" -g "$RESOURCE_GROUP" --yes -o none
fi

b64() { base64 < "$1" | tr -d '\n'; }
DEPLOY_YAML="$(mktemp -t aci-deploy).yaml"
trap 'rm -f "$DEPLOY_YAML"' EXIT

# Training code is shipped as a secret volume mounted at /app.
cat > "$DEPLOY_YAML" <<EOF
apiVersion: '2023-05-01'
location: $ACI_LOCATION
name: $ACI_NAME
type: Microsoft.ContainerInstance/containerGroups
identity:
  type: UserAssigned
  userAssignedIdentities:
    '$ID_RESOURCE_ID': {}
properties:
  osType: Linux
  restartPolicy: Never
  containers:
  - name: trainer
    properties:
      image: $ACI_IMAGE
      command: ["/bin/bash", "/app/entrypoint.sh"]
      resources:
        requests:
          cpu: $ACI_CPU
          memoryInGB: $ACI_MEMORY_GB
      environmentVariables:
      - {name: AZURE_CLIENT_ID, value: '$ID_CLIENT_ID'}
      - {name: STORAGE_ACCOUNT, value: '$STORAGE_ACCOUNT'}
      - {name: BLOB_CONTAINER, value: '$BLOB_CONTAINER'}
      - {name: HF_MODEL_ID, value: '$HF_MODEL_ID'}
      - {name: RUN_ID, value: '$RUN_ID'}
      - {name: MAX_STEPS, value: '$MAX_STEPS'}
      - {name: SAVE_STEPS, value: '$SAVE_STEPS'}
      - {name: TRAIN_SAMPLES, value: '$TRAIN_SAMPLES'}
      volumeMounts:
      - {name: app, mountPath: /app}
  volumes:
  - name: app
    secret:
      entrypoint.sh: $(b64 "$ROOT_DIR/train/entrypoint.sh")
      train.py: $(b64 "$ROOT_DIR/train/train.py")
EOF

az container create -g "$RESOURCE_GROUP" --file "$DEPLOY_YAML" -o none

log "Started. Follow logs with:"
echo "  az container logs -g $RESOURCE_GROUP -n $ACI_NAME --follow"
echo "List checkpoints with:"
echo "  az storage blob list --account-name $STORAGE_ACCOUNT -c $BLOB_CONTAINER --auth-mode login --prefix checkpoints/$RUN_ID/ --query '[].name' -o tsv"
