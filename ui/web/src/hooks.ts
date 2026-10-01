import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthStatus, DeployRequest, DeployStatus, TrainingStatus } from "../../shared/types.ts";
import { api, AUTH_REQUIRED_EVENT } from "./api.ts";

/** Runs `load` whenever deps change; stale responses are discarded. */
export function useAsync<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: false });
  useEffect(() => {
    if (!load) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState({ loading: true });
    load().then(
      (data) => live && setState({ data, loading: false }),
      (e: Error) => live && setState({ error: e.message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Azure CLI sign-in state; polls while a browser sign-in is pending. */
export function useAuth() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api.authStatus().then(setStatus, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_REQUIRED_EVENT, refresh);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (!status?.loginInProgress) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [status?.loginInProgress, refresh]);

  const run = (action: () => Promise<AuthStatus>) => {
    setError("");
    action().then(setStatus, (e: Error) => setError(e.message));
  };

  return {
    status,
    error,
    login: (tenant: string) => run(() => api.login(tenant)),
    logout: () => run(api.logout),
  };
}

/** Deployment job state, polled from the server while it runs. */
export function useDeployJob() {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const next = useRef(0);

  const apply = (s: DeployStatus, reset: boolean) => {
    setLines((prev) => (reset ? s.lines : [...prev, ...s.lines]));
    next.current = s.next;
    setStatus(s);
  };

  // Pick up a job that was started before this page was opened.
  useEffect(() => {
    api.deployStatus(0).then((s) => apply(s, true), () => {});
  }, []);

  useEffect(() => {
    if (status?.state !== "running") return;
    const t = setInterval(() => {
      api.deployStatus(next.current).then((s) => apply(s, false), () => {});
    }, 1500);
    return () => clearInterval(t);
  }, [status?.state]);

  const start = async (req: DeployRequest) => apply(await api.deploy(req), true);
  return { status, lines, start };
}

/** Container instance state and logs, polled until the container stops. */
export function useTraining(key: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<TrainingStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!key || !enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const s = await api.training().catch(() => null);
      if (!live) return;
      if (s) setStatus(s);
      if (s?.state !== "Terminated") timer = setTimeout(poll, 10_000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, enabled]);

  return status;
}
