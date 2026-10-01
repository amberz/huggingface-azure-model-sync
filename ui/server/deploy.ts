// Deployment job: validates a request, then runs the scripts in ../scripts.
// One job at a time; state lives in memory.

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  DEPLOY_STEPS,
  LOCATIONS,
  NAME_RULES,
  identityFor,
  type DeployPlan,
  type DeployStatus,
} from "../shared/types.ts";
import {
  HttpError,
  checkAciName,
  checkResourceGroupName,
  checkStorageName,
  listSubscriptions,
  requireIdentity,
  subscriptionAccess,
} from "./azure.ts";
import { modelInfo } from "./hf.ts";

const job: DeployStatus & { offset: number } = { state: "idle", step: 0, lines: [], next: 0, offset: 0 };
const MAX_LINES = 5000;

export const isDeploying = () => job.state === "running";
export const currentPlan = () => job.plan;

function pushLine(line: string) {
  job.lines.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
  if (job.lines.length > MAX_LINES) {
    job.lines.shift();
    job.offset++;
  }
}

function runScript(repoDir: string, script: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn("bash", [join(repoDir, "scripts", script), ...args], { cwd: repoDir, env });
    let partial = "";
    const onData = (chunk: Buffer) => {
      const parts = (partial + chunk.toString()).split(/\r?\n/);
      partial = parts.pop() ?? "";
      parts.forEach(pushLine);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => pushLine(`ERROR: ${e.message}`));
    child.on("close", (code) => {
      if (partial) pushLine(partial);
      done(code ?? 1);
    });
  });
}

/** Re-checks everything the UI checked: the browser is not trusted. */
async function validate(body: unknown): Promise<DeployPlan> {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const req = {
    subscriptionId: str("subscriptionId"),
    modelLink: str("modelLink"),
    resourceGroup: str("resourceGroup"),
    storageAccount: str("storageAccount"),
    storageLocation: str("storageLocation"),
    aciName: str("aciName"),
    aciLocation: str("aciLocation"),
  };
  if (!NAME_RULES.resourceGroup.test(req.resourceGroup)) throw new HttpError(400, "Invalid resource group name");
  if (!NAME_RULES.storageAccount.test(req.storageAccount)) throw new HttpError(400, "Invalid storage account name");
  if (!NAME_RULES.aciName.test(req.aciName)) throw new HttpError(400, "Invalid container instance name");
  if (!LOCATIONS.includes(req.storageLocation)) throw new HttpError(400, "Invalid storage account location");
  if (!LOCATIONS.includes(req.aciLocation)) throw new HttpError(400, "Invalid container instance location");

  const id = await requireIdentity();
  if (!(await listSubscriptions()).some((s) => s.id === req.subscriptionId)) {
    throw new HttpError(403, "You do not have access to this subscription");
  }
  const [model, acc, rg, storage, aci] = await Promise.all([
    modelInfo(req.modelLink),
    subscriptionAccess(req.subscriptionId, id.objectId),
    checkResourceGroupName(req.subscriptionId, req.resourceGroup),
    checkStorageName(req.subscriptionId, req.storageAccount),
    checkAciName(req.subscriptionId, req.aciName),
  ]);
  if (acc.missingActions.length) {
    throw new HttpError(403, `Your roles do not allow: ${acc.missingActions.join(", ")}`);
  }
  if (!rg.available) throw new HttpError(409, rg.message);
  if (!storage.available) throw new HttpError(409, storage.message);
  if (!aci.available) throw new HttpError(409, aci.message);
  return { ...req, model };
}

export async function startDeploy(repoDir: string, body: unknown): Promise<DeployStatus> {
  if (isDeploying()) throw new HttpError(409, "A deployment is already running");
  const plan = await validate(body);
  if (isDeploying()) throw new HttpError(409, "A deployment is already running");

  Object.assign(job, { state: "running", plan, step: 0, lines: [], offset: 0 });
  const env = {
    ...process.env,
    SUBSCRIPTION_ID: plan.subscriptionId,
    RESOURCE_GROUP: plan.resourceGroup,
    LOCATION: plan.storageLocation,
    STORAGE_ACCOUNT: plan.storageAccount,
    ACI_NAME: plan.aciName,
    ACI_LOCATION: plan.aciLocation,
    IDENTITY_NAME: identityFor(plan.aciName),
    HF_MODEL_ID: plan.model.id,
  };
  // The copy step is pinned to the commit resolved during validation.
  const argsFor = (script: string) => (script === "copy_hf_model.sh" ? [plan.model.id, plan.model.revision] : []);

  void (async () => {
    for (const [i, step] of DEPLOY_STEPS.entries()) {
      job.step = i;
      pushLine(`### Step ${i + 1}/${DEPLOY_STEPS.length}: ${step.title}`);
      const code = await runScript(repoDir, step.script, argsFor(step.script), env);
      if (code !== 0) {
        pushLine(`### Step ${i + 1} failed (exit code ${code})`);
        job.state = "failed";
        return;
      }
    }
    pushLine("### Deployment finished. Training is running in the container instance.");
    job.state = "succeeded";
  })();

  return deployStatus(0);
}

export function deployStatus(since: number): DeployStatus {
  const from = Math.max(0, since - job.offset);
  return { state: job.state, plan: job.plan, step: job.step, lines: job.lines.slice(from), next: job.offset + job.lines.length };
}
