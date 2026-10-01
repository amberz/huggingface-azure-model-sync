huggingface-azure-model-sync
============================

I want to store Hugging Face models and model weights on Azure Storage.
Please complete the following workflow:

* Create an Azure Storage Account
* Create a Blob Container
* Create an Azure Container Instance as the compute resource
* Download Hugging Face Transformers
* Run model training
* Run checkpointing

Project layout
--------------
config.env                     All settings (region, resource names, model, training steps, etc.)
scripts/common.sh              Shared helpers: load config, select subscription, generate storage account name
scripts/01_create_storage.sh   Steps 1-2: resource group, storage account, blob container
scripts/02_run_training_aci.sh Steps 3-6: managed identity, ACI, start training
scripts/copy_hf_model.sh       Copy a Hugging Face model repo into the blob container
train/entrypoint.sh            Container entrypoint: installs PyTorch (CPU) and Transformers
train/train.py                 Training script: blob I/O, training, checkpointing, resume
.state.env                     Generated storage account name (git-ignored)

Prerequisites
-------------
- Azure CLI, jq, python3, openssl (all preinstalled or available via Homebrew)
- Resource providers registered in the subscription:
    Microsoft.Storage, Microsoft.ContainerInstance, Microsoft.ManagedIdentity
  Register a missing one with:
    az provider register -n Microsoft.ContainerInstance

How to run
----------
Run all commands from the repo root.

1. Sign in (once, or whenever the token expires):
    az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47

   - No need to pick a subscription at the prompt; the scripts switch to
     SUBSCRIPTION_ID in config.env.
   - On macOS, use Edge (signed in with the corp profile) as the browser.
     Avoid --use-device-code.

2. (Optional) Edit config.env:
   subscription, region, resource group, resource names, model, training
   steps, ACI CPU/memory.
   Current defaults:
     Subscription    Azure Storage Learning Sub 1
                     (9f52431b-de05-48c0-be2a-f0eda15ca4fa)
     Resource group  rg-hf-model-sync (eastus)
     Container       hf-models
     ACI             aci-hf-trainer (4 vCPU, 16 GB)

3. Create the resource group, storage account and blob container:
    ./scripts/01_create_storage.sh

   Also grants your user "Storage Blob Data Contributor" on the account.

4. Create the managed identity and ACI, and start training:
    ./scripts/02_run_training_aci.sh

   The container installs PyTorch + Hugging Face Transformers, trains, and
   uploads checkpoints to blob storage. Takes about 6-8 minutes in total.

5. Follow the training logs:
    az container logs -g rg-hf-model-sync -n aci-hf-trainer --follow

6. Check the container state (Terminated + exit code 0 = success):
    az container show -g rg-hf-model-sync -n aci-hf-trainer \
      --query "containers[0].instanceView.currentState" -o table

7. List checkpoints / models in blob storage:
    az storage blob list --account-name <STORAGE_ACCOUNT> -c hf-models \
      --auth-mode login --prefix checkpoints/run-001/ --query "[].name" -o tsv

   <STORAGE_ACCOUNT> is in .state.env (currently sthfmodel1db83bb5).

8. Download the fine-tuned model:
    az storage blob download-batch --account-name <STORAGE_ACCOUNT> \
      --auth-mode login -s hf-models --pattern "models/finetuned/run-001/*" -d ./downloads

Web UI (alternative to steps 2-4)
---------------------------------
A local React + TypeScript UI to pick the subscription, resource group,
storage account name and container instance name, then deploy with one click.

    cd ui
    npm install        # first time only
    npm start          # builds the UI and serves it at http://127.0.0.1:8765

Authentication
- Authentication is your Azure CLI sign-in. If you are not signed in (or the
  token expired), the UI shows a "Sign in with Azure CLI" button that runs
  `az login` and opens your browser. An optional tenant can be entered.
- Every API call except sign-in status/login/logout requires a valid sign-in.
- "Sign out" runs `az logout` (this signs the CLI out for your terminal too).

Form
- Model link: a public Hugging Face model URL (or "org/name"), e.g.
  https://huggingface.co/openai-community/gpt2. The UI shows the resolved
  commit, file count, size and license. Gated/private models are rejected.
  Deploy copies it to blob storage, then trains on it.
- Subscription: lists every enabled subscription you have an RBAC role on
  (read live from Azure Resource Manager). After you pick one, the UI shows
  your roles and checks that they allow everything the deployment does:
    resource groups, storage accounts, managed identities, container
    instances, and role assignments (write).
  Owner, or Contributor + User Access Administrator, is enough. Contributor
  alone is not: it cannot create the role assignment for the managed identity.
- Resource group: a new resource group name. It must not already exist in
  the selected subscription; it is created in the storage account's location.
- Storage account name + location.
- Container instance name + location.
- Name rules: the resource group and container instance names must not exist
  in the selected subscription, and the storage account name must not exist
  anywhere in Azure (names are global). If any of them exists, the UI shows an error asking for a
  different name, and the server rejects the deployment as well.


The page then shows each deployment step with live logs, followed by the
container's training state and logs.

Notes
- The server listens on 127.0.0.1 only, rejects cross-site requests, and runs
  one deployment at a time. Job state is in memory: restarting the server
  clears the progress view (resources in Azure are not affected).
- Deploying selects the subscription in your az CLI (az account set).

Code: ui/server/server.ts (HTTP API), ui/server/azure.ts (az sign-in,
      subscriptions, RBAC, name checks), ui/server/deploy.ts (deploy job),
      ui/web/src/ (React app), ui/shared/types.ts (shared types/validation).

Copy a Hugging Face model to blob storage
-----------------------------------------
    ./scripts/copy_hf_model.sh openai-community/gpt2 [revision]

- Server-side copy: Azure Storage pulls each file directly from Hugging Face,
  nothing is downloaded to your machine. Copies the whole repo (all formats).
- Files land in models/base/<repo_id>/ with blob metadata hf_repo and
  hf_revision (the commit sha the copy is pinned to). Sizes are verified.
- Re-running skips files already copied at the same revision.
- Gated/private repos: export HF_TOKEN=<token> first.
- Training reads models/base/<HF_MODEL_ID>/ and downloads only config,
  tokenizer and PyTorch weights (skips ONNX/TFLite/Flax/TF/Rust files).

Rerunning
---------
- Both scripts are idempotent: existing resources are reused.
- Rerunning 02_run_training_aci.sh replaces the container and resumes
  training from the latest complete checkpoint in blob storage.
- For a fresh training run, change RUN_ID in config.env (e.g. run-002).
- Do not delete .state.env: it holds the generated storage account name.
  Without it, the next run creates a new storage account.

Troubleshooting
---------------
- AADSTS700082 (refresh token expired): run az login again.
- AADSTS530084 (conditional access token protection): the org blocks Microsoft
  Graph tokens from the CLI on this device. The scripts already avoid Graph
  (user id read from the ARM token, identity created via ARM REST, role
  assignment list with --fill-principal-name false). Avoid adding
  `az ad ...` or `az role assignment list --assignee ...` calls.
- Container stuck or failed: check the logs (step 5). The training script
  retries on 403 for up to 10 minutes while role assignments propagate.

Blob layout
-----------
models/base/<HF_MODEL_ID>/            Original model weights downloaded from the Hugging Face Hub
checkpoints/<RUN_ID>/checkpoint-N/    Training checkpoints (a _COMPLETE marker is written after upload)
models/finetuned/<RUN_ID>/            Final model after training

Default job: fine-tune distilbert-base-uncased for sentiment classification on
GLUE SST-2 (4000 samples), 200 steps, saving a checkpoint every 50 steps.

Design notes
------------
- Security: the storage account disables shared keys and public access and
  allows Entra ID auth only. ACI accesses blobs through a user-assigned managed
  identity (Storage Blob Data Contributor role); no keys are needed.
- Data protection: 7-day soft delete is enabled for blobs and containers.
- On the first run the model is downloaded from the HF Hub and uploaded to
  blob storage; later runs load it from blob storage.
- Resume: rerunning 02_run_training_aci.sh continues from the latest complete
  checkpoint in blob storage. To start over, change RUN_ID in config.env.
- Training code is mounted into /app via an ACI secret volume, so no custom
  image is needed.

Cleanup
-------
    az group delete -n rg-hf-model-sync --yes --no-wait
