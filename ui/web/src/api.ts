import type {
  AuthStatus,
  DeployRequest,
  DeployStatus,
  ModelInfo,
  NameCheck,
  Subscription,
  SubscriptionAccess,
  TrainingStatus,
} from "../../shared/types.ts";

/** Fired when the server reports the Azure CLI session is gone. */
export const AUTH_REQUIRED_EVENT = "auth-required";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const api = {
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (tenant: string) => post<AuthStatus>("/api/auth/login", { tenant }),
  logout: () => post<AuthStatus>("/api/auth/logout"),

  subscriptions: () => request<Subscription[]>("/api/subscriptions"),
  subscriptionAccess: (subscription: string) =>
    request<SubscriptionAccess>(`/api/subscription-access?${qs({ subscription })}`),
  modelInfo: (link: string) => request<ModelInfo>(`/api/model-info?${qs({ link })}`),
  checkResourceGroup: (subscription: string, name: string) =>
    request<NameCheck>(`/api/check-resource-group?${qs({ subscription, name })}`),
  checkStorageName: (subscription: string, name: string) =>
    request<NameCheck>(`/api/check-storage-name?${qs({ subscription, name })}`),
  checkAciName: (subscription: string, name: string) =>
    request<NameCheck>(`/api/check-aci-name?${qs({ subscription, name })}`),

  deploy: (req: DeployRequest) => post<DeployStatus>("/api/deploy", req),
  deployStatus: (since: number) => request<DeployStatus>(`/api/deploy?${qs({ since: String(since) })}`),
  training: () => request<TrainingStatus>("/api/training"),
};
