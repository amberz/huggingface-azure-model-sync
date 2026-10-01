import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DEPLOY_STEPS, type AuthStatus, type DeployStatus, type TrainingStatus } from "../../shared/types.ts";

export type Tone = "muted" | "ok" | "warn" | "error";

export function Field(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ${props.className ?? ""}`}>
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      <p className={`hint ${props.tone ?? "muted"}`} id={`${props.id}-hint`} role={props.tone === "error" ? "alert" : undefined}>
        {props.hint ?? " "}
      </p>
    </div>
  );
}

export function SignIn({ status, error, onLogin }: { status: AuthStatus; error: string; onLogin: (tenant: string) => void }) {
  const [tenant, setTenant] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onLogin(tenant.trim());
  };
  const message = error || status.loginError;
  return (
    <form className="card signin" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted-text">
        This app deploys with your Azure CLI identity. Signing in runs <code>az login</code>, which opens your browser to
        authenticate with your Microsoft account.
      </p>
      <fieldset disabled={status.loginInProgress}>
        <Field id="tenant" label="Tenant (optional)" hint="Tenant ID or domain. Leave empty for your home tenant.">
          <input
            id="tenant"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            placeholder="e.g. contoso.onmicrosoft.com"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="actions">
          <button type="submit">{status.loginInProgress ? "Waiting for browser sign-in…" : "Sign in with Azure CLI"}</button>
        </div>
      </fieldset>
      {status.loginInProgress && <p className="hint warn">Complete the sign-in in the browser window that opened.</p>}
      {message && (
        <p className="hint error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

export function UserBar({ status, onLogout, disabled }: { status: AuthStatus; onLogout: () => void; disabled: boolean }) {
  return (
    <div className="userbar">
      <span className="user" title={`Tenant ${status.tenantId}`}>
        Signed in as <strong>{status.user}</strong>
      </span>
      <button type="button" className="secondary" onClick={onLogout} disabled={disabled}>
        Sign out
      </button>
    </div>
  );
}

function LogView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre ref={ref} className="log" aria-live="polite">
      {lines.join("\n")}
    </pre>
  );
}

export function DeployProgress({ status, lines }: { status: DeployStatus; lines: string[] }) {
  const stepState = (i: number) => {
    if (status.state === "succeeded" || i < status.step) return "done";
    if (i > status.step) return "pending";
    return status.state === "failed" ? "failed" : "running";
  };
  const p = status.plan;
  return (
    <section className="card">
      <h2>Deployment</h2>
      {p && (
        <dl className="summary">
          <dt>Model</dt>
          <dd>
            {p.model.id} @ {p.model.revision.slice(0, 7)}
          </dd>
          <dt>Resource group</dt>
          <dd>{p.resourceGroup}</dd>
          <dt>Storage account</dt>
          <dd>
            {p.storageAccount} · {p.storageLocation}
          </dd>
          <dt>Container instance</dt>
          <dd>
            {p.aciName} · {p.aciLocation}
          </dd>
        </dl>
      )}
      <ol className="steps">
        {DEPLOY_STEPS.map((s, i) => (
          <li key={s.script} className={stepState(i)}>
            <span className="dot" aria-hidden />
            {s.title}
            <span className="step-state">{stepState(i)}</span>
          </li>
        ))}
      </ol>
      <LogView lines={lines} />
    </section>
  );
}

export function TrainingPanel({ status }: { status: TrainingStatus | null }) {
  const label = !status
    ? "Checking…"
    : status.state === "Terminated"
      ? status.exitCode === 0
        ? "Completed"
        : `Failed (exit ${status.exitCode})`
      : status.state;
  const tone = !status ? "muted" : status.state === "Terminated" ? (status.exitCode === 0 ? "ok" : "error") : "warn";
  return (
    <section className="card">
      <div className="card-head">
        <h2>Training</h2>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <LogView lines={status?.logs.length ? status.logs : ["Waiting for container logs…"]} />
    </section>
  );
}
