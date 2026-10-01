// Hugging Face Hub lookups for the "Model link" field (public models only).

import { parseModelLink, type ModelInfo } from "../shared/types.ts";
import { HttpError } from "./azure.ts";

const HF = "https://huggingface.co";
const cache = new Map<string, { at: number; info: Promise<ModelInfo> }>();
const TTL_MS = 5 * 60_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 404) throw new HttpError(404, "Model not found on Hugging Face (or it is private).");
  if (!res.ok) throw new HttpError(502, `Hugging Face returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchModel(id: string): Promise<ModelInfo> {
  const meta = await getJson<{ id: string; sha: string; gated: boolean | string; private: boolean; library_name?: string; cardData?: { license?: string } }>(
    `${HF}/api/models/${id}`,
  );
  if (meta.private || meta.gated) {
    throw new HttpError(400, `${meta.id} is gated or private. Only public models can be copied from the UI.`);
  }
  // Same listing the copy script uses, pinned to the commit.
  const files = await getJson<{ type: string; size: number; lfs?: { size: number } }[]>(
    `${HF}/api/models/${meta.id}/tree/${meta.sha}?recursive=true`,
  );
  const blobs = files.filter((f) => f.type === "file");
  return {
    id: meta.id,
    revision: meta.sha,
    files: blobs.length,
    bytes: blobs.reduce((n, f) => n + (f.lfs?.size ?? f.size), 0),
    license: meta.cardData?.license,
    libraryName: meta.library_name,
  };
}

export function modelInfo(link: string): Promise<ModelInfo> {
  const id = parseModelLink(link);
  if (!id) throw new HttpError(400, "Enter a Hugging Face model link, e.g. https://huggingface.co/openai-community/gpt2");
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const info = fetchModel(id);
  info.catch(() => cache.delete(id));
  cache.set(id, { at: Date.now(), info });
  return info;
}
