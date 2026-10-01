// Azure CLI wrappers: sign-in state, subscriptions, RBAC access, name checks.
// All calls run as the user signed in to the local `az` CLI.

import { execFile, spawn } from "node:child_process";
import {
  REQUIRED_ACTIONS,
  type AuthStatus,
  type NameCheck,
  type Subscription,
  type SubscriptionAccess,
  type TrainingStatus,
} from "../shared/types.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ARM = "https://management.azure.com";
const MAX_BUFFER = 64 * 1024 * 1024;

function run(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("az", args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return ok(stdout);
      const line = stderr.split("\n").find((l) => l.startsWith("ERROR:")) || stderr.trim() || err.message;
      fail(new HttpError(502, line.replace(/^ERROR:\s*/, "")));
    });
  });
}

export async function az<T>(args: string[]): Promise<T> {
  const out = await run([...args, "-o", "json"]);
  return (out.trim() ? JSON.parse(out) : null) as T;
}

/** GET an ARM path, following nextLink pages for list responses. */
async function armList<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | undefined = ARM + path;
  while (url) {
    const page: { value: T[]; nextLink?: string } = await az(["rest", "--method", "get", "--url", url]);
    items.push(...page.value);
    url = page.nextLink;
  }
  return items;
}

// ---------- Authentication (Azure CLI sign-in) ----------

interface Identity {
  user: string;
  tenantId: string;
  objectId: string;
}

let identity: { value: Identity | null; at: number } | null = null;
let login: { error?: string; running: boolean } = { running: false };
const IDENTITY_TTL_MS = 30_000;

/** Validates the CLI sign-in by requesting an ARM token, and reads its claims. */
async function currentIdentity(): Promise<Identity | null> {
  if (identity && Date.now() - identity.at < IDENTITY_TTL_MS) return identity.value;
  let value: Identity | null = null;
  try {
    const { accessToken } = await az<{ accessToken: string }>(["account", "get-access-token"]);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    value = { user: claims.upn ?? claims.unique_name ?? claims.email ?? claims.oid, tenantId: claims.tid, objectId: claims.oid };
  } catch {
    value = null; // not signed in, or the refresh token expired
  }
  identity = { value, at: Date.now() };
  return value;
}

function resetSession() {
  identity = null;
  subscriptions = null;
  access.clear();
}

export async function authStatus(): Promise<AuthStatus> {
  if (login.running) return { signedIn: false, loginInProgress: true };
  const id = await currentIdentity();
  return id
    ? { signedIn: true, user: id.user, tenantId: id.tenantId, loginInProgress: false }
    : { signedIn: false, loginInProgress: false, loginError: login.error };
}

export async function requireIdentity(): Promise<Identity> {
  const id = login.running ? null : await currentIdentity();
  if (!id) throw new HttpError(401, "Not signed in. Sign in with Azure CLI first.");
  return id;
}

/** Starts `az login`, which opens the system browser for the user to sign in. */
export function startLogin(tenant: string | undefined) {
  if (login.running) return;
  login = { running: true };
  resetSession();
  const args = ["login", "-o", "none", ...(tenant ? ["--tenant", tenant] : [])];
  const child = spawn("az", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout.resume();
  const timeout = setTimeout(() => child.kill(), 5 * 60_000);
  const finish = (error?: string) => {
    clearTimeout(timeout);
    login = { running: false, error };
    resetSession();
  };
  child.on("error", (e) => finish(e.message));
  child.on("close", (code) => {
    const line = stderr.split("\n").find((l) => l.startsWith("ERROR:"));
    finish(code === 0 ? undefined : (line?.replace(/^ERROR:\s*/, "") ?? `az login exited with code ${code}`));
  });
}

export async function logout() {
  await run(["logout"]).catch(() => {}); // already signed out
  login = { running: false };
  resetSession();
}

// ---------- Subscriptions and RBAC ----------

let subscriptions: Promise<Subscription[]> | null = null;

/** Subscriptions the user has an RBAC role on, read live from ARM. */
export function listSubscriptions(): Promise<Subscription[]> {
  subscriptions ??= armList<{ subscriptionId: string; displayName: string; tenantId: string; state: string }>(
    "/subscriptions?api-version=2022-12-01",
  )
    .then((subs) =>
      subs
        .filter((s) => s.state === "Enabled")
        .map((s) => ({ id: s.subscriptionId, name: s.displayName, tenantId: s.tenantId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
    .catch((e) => {
      subscriptions = null;
      throw e;
    });
  return subscriptions;
}

const access = new Map<string, Promise<SubscriptionAccess>>();
const roleNames = new Map<string, Promise<string>>();

const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/** The user's roles on a subscription and which deployment actions they lack. */
export function subscriptionAccess(subId: string, objectId: string): Promise<SubscriptionAccess> {
  let result = access.get(subId);
  if (!result) {
    result = (async () => {
      const scope = `/subscriptions/${subId}`;
      const [perms, assignments] = await Promise.all([
        armList<{ actions: string[]; notActions: string[] }>(
          `${scope}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
        ),
        armList<{ properties: { roleDefinitionId: string } }>(
          `${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01` +
            `&$filter=${encodeURIComponent(`atScope() and assignedTo('${objectId}')`)}`,
        ),
      ]);
      const allowed = (action: string) =>
        perms.some(
          (p) => p.actions.some((a) => wildcard(a).test(action)) && !p.notActions.some((n) => wildcard(n).test(action)),
        );
      const defIds = [...new Set(assignments.map((a) => a.properties.roleDefinitionId))];
      const roles = await Promise.all(defIds.map(roleName));
      return { roles: [...new Set(roles)].sort(), missingActions: REQUIRED_ACTIONS.filter((a) => !allowed(a)) };
    })();
    result.catch(() => access.delete(subId));
    access.set(subId, result);
  }
  return result;
}

function roleName(definitionId: string): Promise<string> {
  const guid = definitionId.split("/").pop()!.toLowerCase();
  let name = roleNames.get(guid);
  if (!name) {
    name = az<{ properties: { roleName: string } }>(["rest", "--method", "get", "--url", `${ARM}${definitionId}?api-version=2022-04-01`])
      .then((d) => d.properties.roleName)
      .catch(() => guid);
    roleNames.set(guid, name);
  }
  return name;
}

// ---------- Name checks ----------

/** Storage account names are global: any existing account blocks the name. */
export async function checkStorageName(subId: string, name: string): Promise<NameCheck> {
  const r = await az<{ nameAvailable: boolean; reason: string | null; message: string | null }>([
    "storage", "account", "check-name", "--subscription", subId, "-n", name,
  ]);
  if (r.nameAvailable) return { available: true };
  return {
    available: false,
    message:
      r.reason === "AlreadyExists"
        ? `Storage account "${name}" already exists. Please choose a different name.`
        : (r.message ?? `Storage account name "${name}" is not available. Please choose a different name.`),
  };
}

/** The resource group must not exist yet in the subscription. */
export async function checkResourceGroupName(subId: string, name: string): Promise<NameCheck> {
  const exists = await az<boolean>(["group", "exists", "--subscription", subId, "-n", name]);
  return exists
    ? { available: false, message: `Resource group "${name}" already exists. Please choose a different name.` }
    : { available: true };
}

/** Container instance names must not exist anywhere in the subscription. */
export async function checkAciName(subId: string, name: string): Promise<NameCheck> {
  let groups: { id: string; name: string }[];
  try {
    groups = await armList(`/subscriptions/${subId}/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01`);
  } catch (e) {
    // Provider not registered yet: no container instances can exist.
    if (String((e as Error).message).includes("MissingSubscriptionRegistration")) return { available: true };
    throw e;
  }
  const match = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (!match) return { available: true };
  const rg = match.id.split("/")[4];
  return {
    available: false,
    message: `Container instance "${name}" already exists (resource group ${rg}). Please choose a different name.`,
  };
}

// ---------- Training status ----------

export async function trainingStatus(subId: string, rg: string, aci: string): Promise<TrainingStatus> {
  const base = ["--subscription", subId, "-g", rg, "-n", aci];
  let info: { state: string | null; exitCode: number | null };
  try {
    info = await az(["container", "show", ...base, "--query",
      "{state:containers[0].instanceView.currentState.state, exitCode:containers[0].instanceView.currentState.exitCode}"]);
  } catch {
    return { state: "NotFound", exitCode: null, logs: [] };
  }
  const raw = await run(["container", "logs", ...base]).catch(() => "");
  const logs = raw
    .split(/\r?\n|\r/)
    .filter((l) => l.trim() && !l.includes("HTTP Request") && !/\d+%\|/.test(l))
    .slice(-60);
  return { state: info.state ?? "Waiting", exitCode: info.exitCode, logs };
}
