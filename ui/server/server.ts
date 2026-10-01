// Local deployment server. Binds to 127.0.0.1 only; every API except
// /api/auth/* requires a valid Azure CLI sign-in and acts as that user.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME_RULES } from "../shared/types.ts";
import {
  HttpError,
  authStatus,
  checkAciName,
  checkResourceGroupName,
  checkStorageName,
  listSubscriptions,
  logout,
  requireIdentity,
  startLogin,
  subscriptionAccess,
  trainingStatus,
} from "./azure.ts";
import { modelInfo } from "./hf.ts";
import { currentPlan, deployStatus, isDeploying, startDeploy } from "./deploy.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8765);
const UI_DIR = resolve(fileURLToPath(import.meta.url), "../..");
const REPO_DIR = resolve(UI_DIR, "..");
const DIST_DIR = join(UI_DIR, "dist");
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new HttpError(413, "Body too large");
  }
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function param(q: URLSearchParams, key: string, rule: RegExp, label: string): string {
  const v = q.get(key);
  if (!v || !rule.test(v)) throw new HttpError(400, `Invalid ${label}`);
  return v;
}

async function requireSubscription(q: URLSearchParams): Promise<string> {
  const id = param(q, "subscription", NAME_RULES.subscriptionId, "subscription id");
  if (!(await listSubscriptions()).some((s) => s.id === id)) throw new HttpError(403, "You do not have access to this subscription");
  return id;
}

async function handleApi(req: IncomingMessage, url: URL): Promise<unknown> {
  const q = url.searchParams;
  const route = `${req.method} ${url.pathname}`;

  // Authentication: open to signed-out users.
  switch (route) {
    case "GET /api/auth/status":
      return authStatus();
    case "POST /api/auth/login": {
      const tenant = String((await readJson(req)).tenant ?? "").trim();
      if (tenant && !NAME_RULES.tenant.test(tenant)) throw new HttpError(400, "Invalid tenant");
      if (isDeploying()) throw new HttpError(409, "A deployment is running");
      startLogin(tenant || undefined);
      return authStatus();
    }
    case "POST /api/auth/logout":
      await readJson(req);
      if (isDeploying()) throw new HttpError(409, "A deployment is running");
      await logout();
      return authStatus();
  }

  // Everything below requires a signed-in user.
  const user = await requireIdentity();
  switch (route) {
    case "GET /api/subscriptions":
      return listSubscriptions();
    case "GET /api/subscription-access":
      return subscriptionAccess(await requireSubscription(q), user.objectId);
    case "GET /api/check-storage-name":
      return checkStorageName(await requireSubscription(q), param(q, "name", NAME_RULES.storageAccount, "storage account name"));
    case "GET /api/model-info":
      return modelInfo(q.get("link") ?? "");
    case "GET /api/check-resource-group":
      return checkResourceGroupName(await requireSubscription(q), param(q, "name", NAME_RULES.resourceGroup, "resource group name"));
    case "GET /api/check-aci-name":
      return checkAciName(await requireSubscription(q), param(q, "name", NAME_RULES.aciName, "container instance name"));
    case "POST /api/deploy":
      return startDeploy(REPO_DIR, await readJson(req));
    case "GET /api/deploy":
      return deployStatus(Number(q.get("since") ?? 0) || 0);
    case "GET /api/training": {
      const plan = currentPlan();
      if (!plan) throw new HttpError(404, "No deployment");
      return trainingStatus(plan.subscriptionId, plan.resourceGroup, plan.aciName);
    }
  }
  throw new HttpError(404, "Not found");
}

async function serveStatic(url: URL, res: ServerResponse) {
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = join(DIST_DIR, rel);
  if (!file.startsWith(DIST_DIR)) throw new HttpError(403, "Forbidden");
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, "Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    // Reject cross-site and DNS-rebinding requests: this server acts as the signed-in Azure user.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) throw new HttpError(403, "Unexpected Host header");
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, "Cross-origin request rejected");

    if (url.pathname.startsWith("/api/")) {
      const data = await handleApi(req, url);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    } else {
      await serveStatic(url, res);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(PORT, HOST, () => {
  console.log(`Deployment UI: http://${HOST}:${PORT}`);
});
