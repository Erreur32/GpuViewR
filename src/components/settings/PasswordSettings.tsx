import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { api } from "../../lib/api";
import { notify } from "../../store/toastStore";
import { useAuthStore } from "../../store/authStore";

const MIN_LENGTH = 8;

/** Settings > General: the signed-in user changes their own password.
 *  The hub checks the current one and returns a fresh token. */
export default function PasswordSettings() {
  const { t } = useTranslation();
  const username = useAuthStore((s) => s.user?.username);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit = !busy && current !== "" && next.length >= MIN_LENGTH && confirm === next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("/auth/password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      localStorage.setItem("gpuviewr.token", r.token);
      useAuthStore.setState({ token: r.token });
      setCurrent("");
      setNext("");
      setConfirm("");
      notify("success", t("settings.password_title"), t("settings.password_done"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <label className="block text-xs space-y-1" htmlFor={id}>
      <span style={{ color: "var(--gv-text-muted)" }}>{label}</span>
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => set(e.target.value)}
        className="w-full px-2 py-1.5 rounded"
        style={{ background: "var(--gv-surface-alt)", border: "1px solid var(--gv-border)", color: "var(--gv-text)" }}
      />
    </label>
  );

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <KeyRound className="w-4 h-4" /> {t("settings.password_title")}
      </h2>
      <p className="text-xs" style={{ color: "var(--gv-text-muted)" }}>
        {t("settings.password_help", { user: username ?? "" })}
      </p>
      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        {/* Lets password managers attach the change to the right account. */}
        <input type="text" name="username" autoComplete="username" value={username ?? ""} readOnly hidden />
        {field("pw-current", t("settings.password_current"), current, setCurrent, "current-password")}
        {field("pw-new", t("settings.password_new"), next, setNext, "new-password")}
        {field("pw-confirm", t("settings.password_confirm"), confirm, setConfirm, "new-password")}
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary text-sm" disabled={!canSubmit}>
            {busy ? t("common.loading") : t("settings.password_submit")}
          </button>
          {tooShort && <span className="text-xs" style={{ color: "var(--gv-warn)" }}>{t("settings.password_too_short", { n: MIN_LENGTH })}</span>}
          {mismatch && <span className="text-xs" style={{ color: "var(--gv-warn)" }}>{t("settings.password_mismatch")}</span>}
          {error && <span className="text-xs" style={{ color: "var(--gv-danger)" }}>{error}</span>}
        </div>
      </form>
    </section>
  );
}
