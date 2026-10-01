import { useState, type FormEvent } from "react";
import { LOCATIONS, NAME_RULES, parseModelLink, type NameCheck } from "../../shared/types.ts";
import { api } from "./api.ts";
import { DeployProgress, Field, SignIn, TrainingPanel, UserBar, type Tone } from "./components.tsx";
import { useAsync, useAuth, useDebounced, useDeployJob, useTraining } from "./hooks.ts";

export function App() {
  const auth = useAuth();
  const job = useDeployJob();
  const running = job.status?.state === "running";
  const status = auth.status;

  return (
    <main>
      <header>
        <div className="title-row">
          <h1>Hugging Face model → Azure Storage deployment</h1>
          {status?.signedIn && <UserBar status={status} onLogout={auth.logout} disabled={running} />}
        </div>
        <p className="sub">
          Creates a storage account and blob container, then trains on an Azure Container Instance with checkpoints
          saved to blob storage.
        </p>
      </header>

      {!status ? (
        <p className="muted-text">{auth.error || "Checking Azure CLI sign-in…"}</p>
      ) : status.signedIn ? (
        <DeployForm key={status.user} job={job} />
      ) : (
        <SignIn status={status} error={auth.error} onLogin={auth.login} />
      )}
    </main>
  );
}

/** Format check locally, then an existence check on Azure (debounced). */
function useNameCheck(
  subId: string,
  value: string,
  rule: RegExp,
  ruleText: string,
  check: (sub: string, name: string) => Promise<NameCheck>,
): { ok: boolean; hint: string; tone: Tone } {
  const debounced = useDebounced(value, 500);
  const valid = rule.test(value);
  const result = useAsync(subId && rule.test(debounced) ? () => check(subId, debounced) : null, [subId, debounced]);

  if (!value) return { ok: false, hint: ruleText, tone: "muted" };
  if (!valid) return { ok: false, hint: ruleText, tone: "error" };
  if (!subId) return { ok: false, hint: "Select a subscription first.", tone: "muted" };
  if (debounced !== value || result.loading) return { ok: false, hint: "Checking name…", tone: "muted" };
  if (result.error) return { ok: false, hint: result.error, tone: "error" };
  if (result.data && !result.data.available) return { ok: false, hint: result.data.message, tone: "error" };
  if (result.data?.available) return { ok: true, hint: "Name is available.", tone: "ok" };
  return { ok: false, hint: ruleText, tone: "muted" };
}

function formatBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} KB`;
}

function DeployForm({ job }: { job: ReturnType<typeof useDeployJob> }) {
  const [subscriptionName, setSubscriptionName] = useState("");
  const [modelLink, setModelLink] = useState("");
  const [resourceGroup, setResourceGroup] = useState("");
  const [storageAccount, setStorageAccount] = useState("");
  const [storageLocation, setStorageLocation] = useState("eastus");
  const [aciName, setAciName] = useState("");
  const [aciLocation, setAciLocation] = useState("eastus");
  const [submitError, setSubmitError] = useState("");
  const running = job.status?.state === "running";

  // Subscriptions the user has RBAC access to, then their roles on the selected one.
  const subs = useAsync(api.subscriptions, []);
  const subscription = subs.data?.find((s) => s.name === subscriptionName);
  const subId = subscription?.id ?? "";
  const access = useAsync(subId ? () => api.subscriptionAccess(subId) : null, [subId]);
  const accessOk = !!access.data && access.data.missingActions.length === 0;

  let subHint: string;
  let subTone: Tone = "muted";
  if (subs.error) [subHint, subTone] = [subs.error, "error"];
  else if (subs.loading) subHint = "Loading subscriptions from your RBAC role assignments…";
  else if (subscriptionName && !subscription) [subHint, subTone] = ["Pick a subscription from the list.", "error"];
  else if (!subscription) subHint = `${subs.data?.length ?? 0} subscriptions available to you.`;
  else if (access.loading) subHint = "Checking your permissions…";
  else if (access.error) [subHint, subTone] = [access.error, "error"];
  else if (access.data && !accessOk)
    [subHint, subTone] = [
      `Your roles (${access.data.roles.join(", ") || "none"}) do not allow: ${access.data.missingActions.join(", ")}. ` +
        "Owner, or Contributor + User Access Administrator, is required.",
      "error",
    ];
  else [subHint, subTone] = [`Your roles: ${access.data?.roles.join(", ") || "inherited"} · can deploy`, "ok"];

  const rg = useNameCheck(
    subId, resourceGroup, NAME_RULES.resourceGroup,
    "Letters, digits, - _ . ( ); up to 90 characters. Must not already exist. Created in the storage account's location.",
    api.checkResourceGroup,
  );
  const storage = useNameCheck(
    subId, storageAccount, NAME_RULES.storageAccount,
    "3–24 lowercase letters and digits. Must not already exist.", api.checkStorageName,
  );
  const aci = useNameCheck(
    subId, aciName, NAME_RULES.aciName,
    "Lowercase letters, digits and hyphens. Must not already exist in the subscription.", api.checkAciName,
  );

  // Model link: parsed locally, then looked up on the Hugging Face Hub.
  const debouncedLink = useDebounced(modelLink.trim(), 500);
  const modelId = parseModelLink(modelLink);
  const model = useAsync(parseModelLink(debouncedLink) ? () => api.modelInfo(debouncedLink) : null, [debouncedLink]);
  const modelChecked = debouncedLink === modelLink.trim() && !model.loading;
  const modelOk = !!modelId && modelChecked && !!model.data;
  let modelHint = "Link to a public model, e.g. https://huggingface.co/openai-community/gpt2";
  let modelTone: Tone = "muted";
  if (modelLink.trim() && !modelId) [modelHint, modelTone] = ["Not a Hugging Face model link.", "error"];
  else if (modelId && !modelChecked) modelHint = "Looking up model on Hugging Face…";
  else if (model.error) [modelHint, modelTone] = [model.error, "error"];
  else if (model.data) {
    const m = model.data;
    modelHint =
      `${m.id} @ ${m.revision.slice(0, 7)} · ${m.files} files · ${formatBytes(m.bytes)}` + (m.license ? ` · license ${m.license}` : "");
    modelTone = "ok";
    if (m.libraryName && m.libraryName !== "transformers") {
      modelHint += ` · library "${m.libraryName}": the copy works, but training expects a Transformers model.`;
      modelTone = "warn";
    }
  }

  const canDeploy = accessOk && modelOk && rg.ok && storage.ok && aci.ok && !running;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canDeploy) return;
    setSubmitError("");
    try {
      await job.start({ subscriptionId: subId, modelLink: modelLink.trim(), resourceGroup, storageAccount, storageLocation, aciName, aciLocation });
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  };

  const plan = job.status?.plan;
  const training = useTraining(plan && `${plan.subscriptionId}/${plan.aciName}`, job.status?.state === "succeeded");

  return (
    <>
      <form className="card" onSubmit={onSubmit} noValidate>
        <fieldset disabled={running}>
          <Field id="model-link" label="Model link" hint={modelHint} tone={modelTone}>
            <input
              id="model-link"
              type="url"
              value={modelLink}
              onChange={(e) => setModelLink(e.target.value)}
              placeholder="https://huggingface.co/openai-community/gpt2"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field id="subscription" label="Subscription" hint={subHint} tone={subTone}>
            <input
              id="subscription"
              list="subscription-list"
              value={subscriptionName}
              onChange={(e) => setSubscriptionName(e.target.value)}
              placeholder={subs.loading ? "Loading…" : "Search subscriptions"}
              autoComplete="off"
            />
            <datalist id="subscription-list">
              {subs.data?.map((s) => <option key={s.id} value={s.name} />)}
            </datalist>
          </Field>

          <Field id="resource-group" label="Resource group" hint={rg.hint} tone={rg.tone}>
            <input
              id="resource-group"
              value={resourceGroup}
              onChange={(e) => setResourceGroup(e.target.value.trim())}
              placeholder="e.g. rg-hf-models-01"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <h3>Storage account</h3>
          <div className="row">
            <Field id="storage-account" label="Name" hint={storage.hint} tone={storage.tone}>
              <input
                id="storage-account"
                value={storageAccount}
                onChange={(e) => setStorageAccount(e.target.value.trim().toLowerCase())}
                placeholder="e.g. sthfmodels01"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field id="storage-location" label="Location" className="narrow">
              <LocationSelect id="storage-location" value={storageLocation} onChange={setStorageLocation} />
            </Field>
          </div>

          <h3>Container instance</h3>
          <div className="row">
            <Field id="aci-name" label="Name" hint={aci.hint} tone={aci.tone}>
              <input
                id="aci-name"
                value={aciName}
                onChange={(e) => setAciName(e.target.value.trim().toLowerCase())}
                placeholder="e.g. aci-hf-trainer-01"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field id="aci-location" label="Location" className="narrow">
              <LocationSelect id="aci-location" value={aciLocation} onChange={setAciLocation} />
            </Field>
          </div>

          <div className="actions">
            <button type="submit" disabled={!canDeploy}>
              {running ? "Deploying…" : "Deploy"}
            </button>
            {submitError && (
              <span className="hint error" role="alert">
                {submitError}
              </span>
            )}
          </div>
        </fieldset>
      </form>

      {job.status && job.status.state !== "idle" && <DeployProgress status={job.status} lines={job.lines} />}
      {job.status?.state === "succeeded" && <TrainingPanel status={training} />}
    </>
  );
}

function LocationSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {LOCATIONS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}
