"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Eye, EyeOff, Shield } from "lucide-react";
import { apiRequest, ClientError } from "@/lib/apiClient";
import { AdminApiError, adminGet, type AdminMe } from "@/components/admin/admin-api";
import "@/components/admin/admin.css";

function AdminLoginForm() {
  const params = useSearchParams();
  const denied = params.get("denied") === "1";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState("");
  const [needsPin, setNeedsPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    denied ? "Нет доступа к панели" : "",
  );

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await apiRequest("/api/auth/sign-in/username", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          ...(needsPin ? { pin } : {}),
        }),
      });
      try {
        await adminGet<AdminMe>("/api/admin/me");
        window.location.replace("/admin");
      } catch (e) {
        if (e instanceof AdminApiError && e.code === "ADMIN_MFA_REQUIRED") {
          setError(
            "Для админ-панели обязателен PIN аккаунта. Включите его в обычных настройках безопасности и войдите снова.",
          );
        } else if (
          e instanceof AdminApiError &&
          e.code === "ADMIN_MFA_REAUTH_REQUIRED"
        ) {
          setError(
            "Для админ-панели нужно войти заново и подтвердить PIN аккаунта.",
          );
        } else if (e instanceof AdminApiError && e.status === 403) {
          setError("Нет доступа к панели");
        } else {
          setError(
            e instanceof Error ? e.message : "Не удалось проверить доступ",
          );
        }
        setBusy(false);
      }
    } catch (e) {
      if (
        e instanceof ClientError &&
        ["PIN_REQUIRED", "PIN_LOCKED"].includes(e.code)
      ) {
        setNeedsPin(true);
      }
      setPin("");
      setError(e instanceof Error ? e.message : "Не удалось войти.");
      setBusy(false);
    }
  }

  return (
    <div className="admin-login">
      <div className="admin-login__card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <Shield size={22} strokeWidth={1.8} aria-hidden />
          <div>
            <h1>БизнеСоты Admin</h1>
            <p className="admin-page-desc" style={{ margin: 0 }}>
              Вход для сотрудников платформы
            </p>
          </div>
        </div>
        {denied && !error ? (
          <p className="admin-error" role="alert">
            Нет доступа к панели
          </p>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          <fieldset disabled={busy}>
            <label htmlFor="admin-login">Логин</label>
            <input
              id="admin-login"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={3}
              maxLength={30}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setNeedsPin(false);
                setPin("");
              }}
            />
            <label htmlFor="admin-password">Пароль</label>
            <div className="admin-password">
              <input
                id="admin-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                minLength={10}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="admin-password__toggle"
                aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                aria-controls="admin-password"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? (
                  <EyeOff size={16} aria-hidden />
                ) : (
                  <Eye size={16} aria-hidden />
                )}
              </button>
            </div>
            {needsPin ? (
              <>
                <label htmlFor="admin-pin">PIN аккаунта</label>
                <input
                  id="admin-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                  pattern="[0-9]{4}"
                  minLength={4}
                  maxLength={4}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/[^0-9]/g, ""))
                  }
                />
              </>
            ) : null}
            {error ? (
              <p className="admin-error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="button button--primary button--full"
              type="submit"
              style={{ marginTop: 8 }}
            >
              {busy ? "Вход…" : "Войти в панель"}
            </button>
          </fieldset>
        </form>
        <p className="admin-page-desc" style={{ marginTop: 16, marginBottom: 0 }}>
          Обычный вход в продукт:{" "}
          <Link className="text-link" href="/login">
            /login
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="admin-login">
          <div className="admin-login__card">Загрузка…</div>
        </div>
      }
    >
      <AdminLoginForm />
    </Suspense>
  );
}
