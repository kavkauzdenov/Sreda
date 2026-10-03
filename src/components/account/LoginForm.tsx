"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import styles from "./Login.module.css";
import { apiRequest, ClientError } from "@/lib/apiClient";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import { PasswordField } from "@/components/ui/PasswordField";

export function LoginForm({ register = false }: { register?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pin, setPin] = useState("");
  const [needsPin, setNeedsPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [codes, setCodes] = useState<string[] | undefined>();
  async function submit() {
    setError("");
    if (register && password !== confirmation) { setError("Пароли не совпадают."); return; }
    setBusy(true);
    try {
      await apiRequest(`/api/auth/${register ? "sign-up" : "sign-in"}/username`, {
        method: "POST", body: JSON.stringify({ username, password, ...(register ? { passwordConfirmation: confirmation } : needsPin ? { pin } : {}) }),
      });
      if (register) {
        try {
          const result = await apiRequest<{ codes: string[] }>("/api/v1/account/recovery-codes", { method: "POST", body: JSON.stringify({ currentPassword: password }) });
          setCodes(result.codes);
        } catch { /* Account exists: show a password-confirmed retry, never repeat signup. */ }
        setPassword(""); setConfirmation(""); setCreated(true); setBusy(false);
      } else window.location.replace("/dashboard");
    } catch (error) {
      if (error instanceof ClientError && ["PIN_REQUIRED", "PIN_LOCKED"].includes(error.code)) setNeedsPin(true);
      setPin("");
      setError(error instanceof Error ? error.message : "Не удалось войти."); setBusy(false);
    }
  }
  if (created) return <RecoveryCodesPanel initialCodes={codes} registration />;
  return <div className={`account-card${register ? "" : ` ${styles.card}`}`}>
    {register && <span className="account-symbol"><LockKeyhole size={26} /></span>}
    <h2>{register ? "Создать аккаунт" : "Войти в БизнеСоты"}</h2>
    <p className={`account-intro${register ? "" : ` ${styles.intro}`}`}>{register ? "Придумайте логин и пароль — и можно начинать." : "Ваш бизнес — под рукой"}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy) void submit(); }}>
      <fieldset className={register ? "form-stack" : undefined} disabled={busy}>
        <div className={register ? "field" : undefined}>
          <label className={register ? "field__label" : undefined} htmlFor="account-login">Логин</label>
          <input id="account-login" className={register ? "field__control" : undefined} placeholder="Введите логин" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={30}
            pattern="[a-zA-Z0-9_.]{3,30}" value={username} onChange={(event) => { setUsername(event.target.value); setNeedsPin(false); setPin(""); }} aria-describedby="login-hint" />
          <p id="login-hint" className={register ? "field-hint" : styles.hidden}>3–30 символов: латинские буквы, цифры, точка или подчёркивание.</p>
        </div>
        <div className={register ? "field" : undefined}>
          <label className={register ? "field__label" : undefined} htmlFor="account-password">Пароль</label>
          {register ? (
            <input id="account-password" className="field__control" placeholder="Введите пароль" type="password" autoComplete="new-password" required minLength={10} maxLength={128}
              value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="password-hint" />
          ) : (
            <PasswordField
              id="account-password"
              className={styles.password}
              toggleClassName={styles.reveal}
              placeholder="Введите пароль"
              value={password}
              onChange={setPassword}
            />
          )}
          {register ? <p id="password-hint" className="field-hint">От 10 символов.</p> : null}
        </div>
        {register ? (
          <div className="field">
            <label className="field__label" htmlFor="account-confirmation">Повторите пароль</label>
            <input id="account-confirmation" className="field__control" type="password" autoComplete="new-password" required minLength={10} maxLength={128} placeholder="Повторите пароль"
              value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </div>
        ) : null}
        {!register && needsPin && <div>
          <label htmlFor="account-pin">PIN аккаунта</label>
          <input id="account-pin" type="password" inputMode="numeric" autoComplete="off" autoFocus required pattern="[0-9]{4}" minLength={4} maxLength={4}
            value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))} aria-describedby="pin-hint" />
          <p id="pin-hint" className="account-footnote">Четыре цифры, которые вы задали в настройках.</p>
        </div>}
        {error && <p className="account-error" role="alert">{error}</p>}
        {!register && <Link className={styles.recover} href="/recover">Забыли пароль или PIN?</Link>}
        <button className={`button button--primary button--full${register ? "" : ` ${styles.submit}`}`} type="submit">{busy ? "Подождите…" : register ? "Создать аккаунт" : "Войти"}<ArrowRight size={20} aria-hidden="true" /></button>
      </fieldset>
    </form>
    <p className={register ? "account-footnote" : styles.footer}>{register ? "Уже есть аккаунт?" : "Нет аккаунта?"} <Link className="text-link" href={register ? "/login" : "/register"}>{register ? "Войти" : "Создать"}</Link></p>
  </div>;
}
