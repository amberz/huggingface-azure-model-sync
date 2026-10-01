// Types shared by the server and the browser.

export interface AuthStatus {
  signedIn: boolean;
  user?: string;
  tenantId?: string;
  /** An `az login` started from the UI is waiting for the browser sign-in. */
  loginInProgress: boolean;
  loginError?: string;
}

export interface Subscription {
  id: string;
  name: string;
  tenantId: string;
}

/** The signed-in user's RBAC access to a subscription. */
export interface SubscriptionAccess {
  roles: string[];
  /** Actions needed for deployment that the user's roles do not grant. */
  missingActions: string[];
}

/** Result of checking that a resource name is free to use. */
export type NameCheck = { available: true } | { available: false; message: string };

/** A Hugging Face model resolved from the "Model link" field. */
export interface ModelInfo {
  id: string; // e.g. openai-community/gpt2
  revision: string; // commit sha the copy is pinned to
  files: number;
  bytes: number;
  license?: string;
  libraryName?: string;
}

export interface DeployRequest {
  subscriptionId: string;
  modelLink: string;
  resourceGroup: string;
  storageAccount: string;
  storageLocation: string;
  aciName: string;
  aciLocation: string;
}

/** Deployment request plus the values derived from it on the server. */
export interface DeployPlan extends DeployRequest {
  model: ModelInfo;
}

export type JobState = "idle" | "running" | "succeeded" | "failed";

export interface DeployStatus {
  state: JobState;
  plan?: DeployPlan;
  /** Index into DEPLOY_STEPS of the step running (or that failed). */
  step: number;
  lines: string[];
  /** Pass back as `since` to receive only newer lines. */
  next: number;
}

export interface TrainingStatus {
  state: string; // Waiting | Running | Terminated | NotFound
  exitCode: number | null;
  logs: string[];
}

export const DEPLOY_STEPS = [
  { title: "Resource group, storage account & blob container", script: "01_create_storage.sh" },
  { title: "Copy Hugging Face model to blob storage", script: "copy_hf_model.sh" },
  { title: "Managed identity & container instance (training)", script: "02_run_training_aci.sh" },
] as const;

/** ARM actions the deployment performs; checked against the user's RBAC permissions. */
export const REQUIRED_ACTIONS = [
  "Microsoft.Resources/subscriptions/resourceGroups/write",
  "Microsoft.Storage/storageAccounts/write",
  "Microsoft.ManagedIdentity/userAssignedIdentities/write",
  "Microsoft.ContainerInstance/containerGroups/write",
  "Microsoft.Authorization/roleAssignments/write",
];

export const NAME_RULES = {
  // 1-90 chars: letters, digits, - _ . ( ); must not end with a period.
  resourceGroup: /^[-\w.()]{0,89}[-\w()]$/,
  storageAccount: /^[a-z0-9]{3,24}$/,
  aciName: /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
  location: /^[a-z0-9]+$/,
  subscriptionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  tenant: /^[-a-zA-Z0-9.]{1,256}$/,
};

const HF_REPO_ID = /^[A-Za-z0-9][-\w.]{0,95}(\/[A-Za-z0-9][-\w.]{0,95})?$/;

/**
 * Accepts "https://huggingface.co/<org>/<name>" (optionally with /tree/<rev>
 * or other trailing path) or a bare "<org>/<name>". Returns the repo id.
 */
export function parseModelLink(link: string): string | null {
  let s = link.trim();
  const m = s.match(/^https?:\/\/(?:www\.)?huggingface\.co\/(.+)$/i);
  if (m) s = m[1];
  else if (/^[a-z]+:\/\//i.test(s)) return null; // some other site
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = s.split("/");
  if (["datasets", "spaces"].includes(parts[0])) return null;
  const id = parts.length >= 2 && !["tree", "blob", "resolve"].includes(parts[1]) ? `${parts[0]}/${parts[1]}` : parts[0];
  return HF_REPO_ID.test(id) && !id.includes("..") ? id : null;
}

/** Managed identity used by the container instance to reach blob storage. */
export const identityFor = (aciName: string) => `id-${aciName}`;

export const LOCATIONS = [
  "eastus", "eastus2", "westus", "westus2", "westus3", "centralus", "northcentralus", "southcentralus",
  "canadacentral", "brazilsouth", "northeurope", "westeurope", "uksouth", "francecentral",
  "germanywestcentral", "swedencentral", "switzerlandnorth", "eastasia", "southeastasia",
  "japaneast", "koreacentral", "centralindia", "australiaeast",
];
