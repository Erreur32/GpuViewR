import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, EyeOff, KeyRound, UserRound } from "lucide-react";
import { api } from "../../lib/api";
import { notify } from "../../store/toastStore";
import { useAuthStore, type AuthUser } from "../../store/authStore";

const MIN_PASSWORD = 8;
const MIN_USERNAME = 3;

/** Settings > General > User: the signed-in user renames their account
 *  or changes their password. Both are gated on the current password;
 *  the hub returns a fresh token each time. */
export default function AccountSettings() {
  const { t } = useTranslation();
  const username = useAuthStore((s) => s.user?.username) ?? "";
  return (
    <section className="card p-5 space-y-4">
      <div>
        <h2 className="font-semibold flex items-center gap-2">
          <UserRound className="w-4 h-4" /> {t("settings.account_title")}
        </h2>
        <p className="text-xs mt-1" style={{ color: "var(--gv-text-muted)" }}>
          {t("settings.account_help", { user: username })}
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UsernameForm username={username} />
        <PasswordForm username={username} />
      </div>
    </section>
  );
}

function saveSession(token: string, user?: AuthUser) {
  localStorage.setItem("gpuviewr.token", token);
  if (user) localStorage.setItem("gpuviewr.user", JSON.stringify(user));
  useAuthStore.setState(user ? { token, user } : { token });
}

/** Shared busy/error plumbing of the two forms: `run` only fires when
 *  `canSubmit`, and a thrown error lands in `error`. */
function useAccountSubmit(canSubmit: boolean, run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function UsernameForm({ username }: Readonly<{ username: string }>) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");

  const trimmed = name.trim();
  let nameHint: string | null = null;
  if (trimmed.length > 0 && trimmed.length < MIN_USERNAME) nameHint = t("settings.username_too_short", { n: MIN_USERNAME });
  else if (trimmed !== "" && trimmed === username) nameHint = t("settings.username_same");
  const valid = current !== "" && trimmed.length >= MIN_USERNAME && trimmed !== username;

  const { busy, error, submit } = useAccountSubmit(valid, async () => {
    const r = await api<{ token: string; user: AuthUser }>("/auth/username", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_username: trimmed }),
    });
    saveSession(r.token, r.user);
    setName("");
    setCurrent("");
    notify("success", t("settings.username_title"), t("settings.username_done", { user: r.user.username }));
  });

  return (
    <Panel icon={<UserRound className="w-4 h-4" />} title={t("settings.username_title")} onSubmit={submit}>
      <Field id="acc-name-current" label={t("settings.username_current")}>
        <input id="acc-name-current" className="input opacity-70" value={username} readOnly tabIndex={-1} />
      </Field>
      <Field id="acc-name-new" label={t("settings.username_new")} hint={nameHint}>
        <input
          id="acc-name-new"
          className="input"
          value={name}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="acc-name-pw" label={t("settings.password_current")}>
        <SecretInput id="acc-name-pw" value={current} onChange={setCurrent} autoComplete="current-password" />
      </Field>
      <Footer busy={busy} canSubmit={valid && !busy} error={error} label={t("settings.username_submit")} />
    </Panel>
  );
}

function PasswordForm({ username }: Readonly<{ username: string }>) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  let nextHint: string | null = null;
  if (next.length > 0 && next.length < MIN_PASSWORD) nextHint = t("settings.password_too_short", { n: MIN_PASSWORD });
  else if (next !== "" && next === current) nextHint = t("settings.password_same");
  const mismatch = confirm.length > 0 && confirm !== next;
  const matches = confirm.length > 0 && confirm === next && next.length >= MIN_PASSWORD;
  const valid = current !== "" && next.length >= MIN_PASSWORD && next !== current && confirm === next;

  const { busy, error, submit } = useAccountSubmit(valid, async () => {
    const r = await api<{ token: string }>("/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    saveSession(r.token);
    setCurrent("");
    setNext("");
    setConfirm("");
    notify("success", t("settings.password_title"), t("settings.password_done"));
  });

  return (
    <Panel icon={<KeyRound className="w-4 h-4" />} title={t("settings.password_title")} onSubmit={submit}>
      {/* Lets password managers attach the change to the right account. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <Field id="acc-pw-current" label={t("settings.password_current")}>
        <SecretInput id="acc-pw-current" value={current} onChange={setCurrent} autoComplete="current-password" />
      </Field>
      <Field id="acc-pw-new" label={t("settings.password_new")} hint={nextHint}>
        <SecretInput id="acc-pw-new" value={next} onChange={setNext} autoComplete="new-password" />
        <StrengthBar value={next} />
      </Field>
      <Field
        id="acc-pw-confirm"
        label={t("settings.password_confirm")}
        hint={mismatch ? t("settings.password_mismatch") : null}
        ok={matches ? t("settings.password_match") : null}
      >
        <SecretInput id="acc-pw-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      </Field>
      <Footer busy={busy} canSubmit={valid && !busy} error={error} label={t("settings.password_submit")} />
    </Panel>
  );
}

function Panel({ icon, title, onSubmit, children }: Readonly<{
  icon: ReactNode;
  title: string;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}>) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{ border: "1px solid var(--gv-border)", background: "color-mix(in srgb, var(--gv-text) 3%, transparent)" }}
    >
      <h3 className="text-sm font-semibold flex items-center gap-2">{icon} {title}</h3>
      {children}
    </form>
  );
}

function Field({ id, label, hint, ok, children }: Readonly<{
  id: string;
  label: string;
  hint?: string | null;
  ok?: string | null;
  children: ReactNode;
}>) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium" style={{ color: "var(--gv-text-muted)" }}>
        {label}
      </label>
      {children}
      {hint && <p className="text-xs" style={{ color: "var(--gv-warn)" }}>{hint}</p>}
      {!hint && ok && (
        <p className="text-xs flex items-center gap-1" style={{ color: "var(--gv-ok)" }}>
          <Check className="w-3.5 h-3.5" /> {ok}
        </p>
      )}
    </div>
  );
}

function SecretInput({ id, value, onChange, autoComplete }: Readonly<{
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}>) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={revealed ? "text" : "password"}
        className="input pr-10"
        value={value}
        autoComplete={autoComplete}
        spellCheck={false}
        maxLength={256}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? t("settings.password_hide") : t("settings.password_show")}
        aria-pressed={revealed}
        className="absolute top-1/2 right-2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gv-surface)] transition-colors"
        style={{ color: "var(--gv-text-muted)" }}
      >
        {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

/** 0..4: length tiers plus character-class variety. A hint, not a policy:
 *  the hub only enforces the minimum length. */
function strength(pw: string): number {
  if (pw.length < MIN_PASSWORD) return pw.length > 0 ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let score = 1;
  if (pw.length >= 12) score++;
  if (classes >= 3) score++;
  if (pw.length >= 16 && classes >= 2) score++;
  return Math.min(score, 4);
}

const STRENGTH_COLORS = ["var(--gv-border)", "var(--gv-danger)", "var(--gv-warn)", "var(--gv-info)", "var(--gv-ok)"];
const STRENGTH_LABELS = ["", "settings.password_weak", "settings.password_fair", "settings.password_good", "settings.password_strong"];

function StrengthBar({ value }: Readonly<{ value: string }>) {
  const { t } = useTranslation();
  const score = strength(value);
  if (score === 0) return null;
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="flex-1 grid grid-cols-4 gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className="h-1 rounded-full"
            style={{ background: step <= score ? STRENGTH_COLORS[score] : "var(--gv-border)" }}
          />
        ))}
      </div>
      <span className="text-[11px] w-14 text-right" style={{ color: STRENGTH_COLORS[score] }}>
        {t(STRENGTH_LABELS[score])}
      </span>
    </div>
  );
}

function Footer({ busy, canSubmit, error, label }: Readonly<{
  busy: boolean;
  canSubmit: boolean;
  error: string | null;
  label: string;
}>) {
  const { t } = useTranslation();
  return (
    <div className="mt-auto pt-1 flex flex-wrap items-center justify-end gap-3">
      {error && <span className="text-xs mr-auto" style={{ color: "var(--gv-danger)" }}>{error}</span>}
      <button type="submit" className="btn-primary text-sm" disabled={!canSubmit}>
        {busy ? t("common.loading") : label}
      </button>
    </div>
  );
}
