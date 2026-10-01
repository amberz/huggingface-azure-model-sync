"""Fine-tune a Hugging Face model inside ACI, using Azure Blob Storage for
base weights, checkpoints (with resume), and the final model.

Blob layout in the container:
  models/base/<HF_MODEL_ID>/          base weights mirrored from the HF Hub
  checkpoints/<RUN_ID>/checkpoint-N/  Trainer checkpoints (+ _COMPLETE marker)
  models/finetuned/<RUN_ID>/          final fine-tuned model
"""

import logging
import os
import re
import time
from pathlib import Path

from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import ContainerClient
from datasets import load_dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("train")
logging.getLogger("azure").setLevel(logging.WARNING)

STORAGE_ACCOUNT = os.environ["STORAGE_ACCOUNT"]
BLOB_CONTAINER = os.environ["BLOB_CONTAINER"]
HF_MODEL_ID = os.environ.get("HF_MODEL_ID", "distilbert-base-uncased")
RUN_ID = os.environ.get("RUN_ID", "run-001")
MAX_STEPS = int(os.environ.get("MAX_STEPS", "200"))
SAVE_STEPS = int(os.environ.get("SAVE_STEPS", "50"))
TRAIN_SAMPLES = int(os.environ.get("TRAIN_SAMPLES", "4000"))

WORK = Path("/work")
BASE_DIR = WORK / "base"
OUTPUT_DIR = WORK / "output"
FINAL_DIR = WORK / "final"

BASE_PREFIX = f"models/base/{HF_MODEL_ID}"
CKPT_PREFIX = f"checkpoints/{RUN_ID}"
FINAL_PREFIX = f"models/finetuned/{RUN_ID}"
COMPLETE_MARKER = "_COMPLETE"


def connect() -> ContainerClient:
    """Connect with the managed identity, waiting out RBAC propagation."""
    client = ContainerClient(
        f"https://{STORAGE_ACCOUNT}.blob.core.windows.net",
        BLOB_CONTAINER,
        credential=DefaultAzureCredential(),
    )
    for attempt in range(1, 31):
        try:
            client.upload_blob("_health/probe.txt", b"ok", overwrite=True)
            log.info("Connected to %s/%s", STORAGE_ACCOUNT, BLOB_CONTAINER)
            return client
        except HttpResponseError as e:
            if e.status_code != 403:
                raise
            log.info("403 from storage (RBAC propagating?), retry %d/30", attempt)
            time.sleep(20)
    raise RuntimeError("Managed identity never got blob access")


def upload_dir(client: ContainerClient, local: Path, prefix: str) -> None:
    files = [p for p in local.rglob("*") if p.is_file()]
    for path in files:
        with path.open("rb") as f:
            client.upload_blob(f"{prefix}/{path.relative_to(local).as_posix()}", f,
                               overwrite=True, max_concurrency=4)
    log.info("Uploaded %d files -> %s", len(files), prefix)


def download_prefix(client: ContainerClient, prefix: str, local: Path) -> None:
    count = 0
    for blob in client.list_blobs(name_starts_with=f"{prefix}/"):
        dest = local / blob.name[len(prefix) + 1:]
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as f:
            client.download_blob(blob.name, max_concurrency=4).readinto(f)
        count += 1
    log.info("Downloaded %d files <- %s", count, prefix)


def blob_exists(client: ContainerClient, name: str) -> bool:
    return client.get_blob_client(name).exists()


# A mirrored repo can hold the same weights in many formats; training only
# needs config, tokenizer and PyTorch weights.
SKIP_SUFFIXES = (".tflite", ".msgpack", ".h5", ".ot", ".onnx", ".onnx_data", ".gguf", ".mlmodel")


def download_base_model(client: ContainerClient) -> None:
    names = [b.name for b in client.list_blobs(name_starts_with=f"{BASE_PREFIX}/")]
    rel = [n[len(BASE_PREFIX) + 1:] for n in names]
    has_safetensors = any(r.endswith(".safetensors") for r in rel)
    wanted = [
        r for r in rel
        if "/" not in r  # top-level only: skips onnx/, coreml/, etc.
        and not r.endswith(SKIP_SUFFIXES)
        and not (has_safetensors and r.endswith(".bin") and "model" in r)
    ]
    for r in wanted:
        dest = BASE_DIR / r
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as f:
            client.download_blob(f"{BASE_PREFIX}/{r}", max_concurrency=4).readinto(f)
    log.info("Downloaded %d of %d files <- %s", len(wanted), len(rel), BASE_PREFIX)


def ensure_base_model(client: ContainerClient) -> None:
    """Load base weights from blob; on first run mirror them from the HF Hub."""
    if blob_exists(client, f"{BASE_PREFIX}/config.json"):
        log.info("Base model found in blob storage")
        download_base_model(client)
        return
    log.info("Downloading %s from Hugging Face Hub", HF_MODEL_ID)
    AutoTokenizer.from_pretrained(HF_MODEL_ID).save_pretrained(BASE_DIR)
    AutoModelForSequenceClassification.from_pretrained(HF_MODEL_ID, num_labels=2).save_pretrained(BASE_DIR)
    upload_dir(client, BASE_DIR, BASE_PREFIX)


def restore_latest_checkpoint(client: ContainerClient) -> str | None:
    """Download the newest fully-uploaded checkpoint for this run, if any."""
    steps = []
    for blob in client.list_blobs(name_starts_with=f"{CKPT_PREFIX}/"):
        m = re.fullmatch(rf"{re.escape(CKPT_PREFIX)}/checkpoint-(\d+)/{COMPLETE_MARKER}", blob.name)
        if m:
            steps.append(int(m.group(1)))
    if not steps:
        log.info("No checkpoint in blob storage, starting fresh")
        return None
    name = f"checkpoint-{max(steps)}"
    local = OUTPUT_DIR / name
    download_prefix(client, f"{CKPT_PREFIX}/{name}", local)
    (local / COMPLETE_MARKER).unlink(missing_ok=True)
    log.info("Resuming from %s", name)
    return str(local)


class BlobCheckpointCallback(TrainerCallback):
    """Upload every checkpoint the Trainer writes; the marker goes last so a
    half-uploaded checkpoint is never used for resume."""

    def __init__(self, client: ContainerClient):
        self.client = client

    def on_save(self, args, state, control, **kwargs):
        if not state.is_world_process_zero:
            return
        name = f"checkpoint-{state.global_step}"
        upload_dir(self.client, Path(args.output_dir) / name, f"{CKPT_PREFIX}/{name}")
        self.client.upload_blob(f"{CKPT_PREFIX}/{name}/{COMPLETE_MARKER}", b"", overwrite=True)


def main() -> None:
    client = connect()
    ensure_base_model(client)

    tokenizer = AutoTokenizer.from_pretrained(BASE_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(BASE_DIR, num_labels=2)
    if tokenizer.pad_token is None:  # e.g. GPT-2: batching needs a pad token
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.pad_token_id

    ds = load_dataset("nyu-mll/glue", "sst2", split="train").shuffle(seed=42).select(range(TRAIN_SAMPLES))
    ds = ds.map(lambda b: tokenizer(b["sentence"], truncation=True, max_length=128),
                batched=True, remove_columns=["sentence", "idx"])

    args = TrainingArguments(
        output_dir=str(OUTPUT_DIR),
        max_steps=MAX_STEPS,
        per_device_train_batch_size=16,
        learning_rate=5e-5,
        logging_steps=10,
        save_strategy="steps",
        save_steps=SAVE_STEPS,
        save_total_limit=2,  # local disk only; blob keeps every checkpoint
        report_to="none",
        seed=42,
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=ds,
        data_collator=DataCollatorWithPadding(tokenizer),
        callbacks=[BlobCheckpointCallback(client)],
    )
    trainer.train(resume_from_checkpoint=restore_latest_checkpoint(client))

    trainer.save_model(str(FINAL_DIR))
    tokenizer.save_pretrained(FINAL_DIR)
    upload_dir(client, FINAL_DIR, FINAL_PREFIX)
    log.info("Done. Final model: https://%s.blob.core.windows.net/%s/%s/",
             STORAGE_ACCOUNT, BLOB_CONTAINER, FINAL_PREFIX)


if __name__ == "__main__":
    main()
