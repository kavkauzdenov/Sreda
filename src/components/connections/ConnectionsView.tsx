"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { apiRequest } from "@/lib/apiClient";
import { platformLabel } from "@/lib/labels";
import type { Platform } from "@/types";

type TokenPlatform = "telegram" | "vk";
type MetaPlatform = "whatsapp" | "instagram";
type ConnectionPlatform = TokenPlatform | MetaPlatform;

type Connection = {
  id: string;
  platform: ConnectionPlatform;
  displayName: string | null;
  status: string;
  displayPhoneNumber?: string | null;
  igUsername?: string | null;
  runtimeStatus?: string | null;
};

type MetaStatus = {
  configured: boolean;
  enabled: boolean;
  whatsappEmbeddedSignupReady: boolean;
  instagramLoginReady: boolean;
  appId: string | null;
  whatsappConfigId: string | null;
  instagramConfigId: string | null;
  graphApiVersion: string;
};

declare global {
  interface Window {
    FB?: {
      init: (opts: Record<string, unknown>) => void;
      login: (
        cb: (response: {
          authResponse?: { code?: string; accessToken?: string };
        }) => void,
        opts: Record<string, unknown>,
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.FB) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        cookie: true,
        xfbml: false,
        version: "v25.0",
      });
      resolve();
    };
    if (document.getElementById("facebook-jssdk")) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/ru_RU/sdk.js";
    script.async = true;
    script.onerror = () =>
      reject(new Error("Не удалось загрузить Facebook SDK."));
    document.body.appendChild(script);
  });
}

export function ConnectionsView() {
  const { currentBusiness } = useBusinessContext();
  if (!currentBusiness) return <p>Выберите бизнес.</p>;
  if (currentBusiness.role === "operator")
    return <p>Подключениями управляет владелец или администратор.</p>;
  return <Connections key={currentBusiness.id} id={currentBusiness.id} />;
}

function Connections({ id }: { id: string }) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [tokens, setTokens] = useState({ telegram: "", vk: "" }),
    [metaStatus, setMetaStatus] = useState<MetaStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmation, setConfirmation] = useState<ConnectionPlatform | null>(null),
    [igCandidates, setIgCandidates] = useState<
      {
        pageId: string;
        pageName: string;
        igUserId: string;
        igUsername: string | null;
        accessToken: string;
      }[]
    >([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmTitleId = useId();
  const confirmDescId = useId();
  const base = `/api/v1/businesses/${id}`;
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiRequest<Connection[]>(base + "/connections"),
      apiRequest<MetaStatus>("/api/v1/meta/status"),
    ])
      .then(([c, status]) => {
        if (!alive) return;
        setConnections(c);
        setMetaStatus(status);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirmation) {
      if (!dialog.open) dialog.showModal();
      cancelRef.current?.focus();
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
    if (dialog.open) dialog.close();
  }, [confirmation]);

  async function refresh() {
    setConnections(await apiRequest<Connection[]>(base + "/connections"));
    setMetaStatus(await apiRequest<MetaStatus>("/api/v1/meta/status"));
  }

  async function act(
    platform: TokenPlatform,
    action: "connect" | "start" | "stop" | "disconnect",
  ) {
    if (busy) return;
    if (action === "connect" && !tokens[platform].trim()) {
      setError(
        "Вставьте токен " +
          (platform === "telegram" ? "бота из @BotFather." : "сообщества VK."),
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "connect") {
        const token = tokens[platform].trim();
        setTokens((v) => ({ ...v, [platform]: "" }));
        await apiRequest(base + "/connections", {
          method: "POST",
          body: JSON.stringify({ platform, token }),
        });
        setNotice(
          "Токен проверен и сохранён. Подключите нужные решения и нажмите «Запустить бота».",
        );
      } else if (action === "start") {
        await apiRequest(base + "/" + platform + "/start", { method: "POST" });
        setNotice("Бот запущен. Клиенты могут писать в этот канал.");
      } else if (action === "stop") {
        await apiRequest(base + "/" + platform + "/stop", { method: "POST" });
        setNotice("Бот остановлен. Подключение и токен сохранены.");
      } else {
        await apiRequest(base + "/connections?platform=" + platform, {
          method: "DELETE",
        });
        setConfirmation(null);
        setNotice("Подключение отключено, токен удалён.");
      }
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function metaDisconnect(platform: MetaPlatform) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(base + "/connections?platform=" + platform, {
        method: "DELETE",
      });
      setConfirmation(null);
      setNotice("Подключение отключено.");
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось отключить канал.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function metaStart(platform: MetaPlatform) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(base + "/meta/start", {
        method: "POST",
        body: JSON.stringify({ platform }),
      });
      setNotice("Приём сообщений Meta настроен.");
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось запустить канал Meta.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function connectMeta(platform: MetaPlatform) {
    if (busy || !metaStatus?.configured) return;
    setBusy(true);
    setError("");
    setNotice("");
    setIgCandidates([]);
    try {
      const start = await apiRequest<
        MetaStatus & { state: string; configId: string | null; appId: string }
      >(base + "/meta/start", {
        method: "POST",
        body: JSON.stringify({ platform, action: "oauth" }),
      });
      if (!start.appId || !start.configId)
        throw new Error("Требуется настройка Meta на сервере.");
      await loadFacebookSdk(start.appId);
      const redirectUri = window.location.origin + "/connections";
      await new Promise<void>((resolve, reject) => {
        window.FB?.login(
          (response) => {
            void (async () => {
              try {
                const code = response.authResponse?.code;
                if (!code) {
                  reject(
                    new Error("Авторизация Meta не завершена. Попробуйте снова."),
                  );
                  return;
                }
                if (platform === "whatsapp") {
                  const session = (
                    window as unknown as {
                      __sotyWaSession?: {
                        wabaId?: string;
                        phoneNumberId?: string;
                      };
                    }
                  ).__sotyWaSession;
                  if (!session?.wabaId || !session?.phoneNumberId) {
                    reject(
                      new Error(
                        "Не получены данные WhatsApp Embedded Signup. Завершите мастер подключения в окне Meta.",
                      ),
                    );
                    return;
                  }
                  await apiRequest(base + "/meta/callback", {
                    method: "POST",
                    body: JSON.stringify({
                      action: "whatsapp_embedded_signup",
                      code,
                      redirectUri,
                      state: start.state,
                      wabaId: session.wabaId,
                      phoneNumberId: session.phoneNumberId,
                    }),
                  });
                  setNotice(
                    "WhatsApp подключён. Нажмите «Запустить приём», чтобы активировать webhook.",
                  );
                } else {
                  const result = await apiRequest<{
                    candidates: {
                      pageId: string;
                      pageName: string;
                      igUserId: string;
                      igUsername: string | null;
                      accessToken: string;
                    }[];
                  }>(base + "/meta/callback", {
                    method: "POST",
                    body: JSON.stringify({
                      action: "instagram_login",
                      code,
                      redirectUri,
                      state: start.state,
                    }),
                  });
                  if (result.candidates.length === 1) {
                    const c = result.candidates[0]!;
                    await apiRequest(base + "/meta/callback", {
                      method: "POST",
                      body: JSON.stringify({
                        action: "instagram_select",
                        pageId: c.pageId,
                        igUserId: c.igUserId,
                        accessToken: c.accessToken,
                        igUsername: c.igUsername,
                        pageName: c.pageName,
                      }),
                    });
                    setNotice(
                      "Instagram подключён. Нажмите «Запустить приём», чтобы активировать webhook.",
                    );
                  } else {
                    setIgCandidates(result.candidates);
                    setNotice("Выберите аккаунт Instagram для подключения.");
                  }
                }
                await refresh();
                resolve();
              } catch (e) {
                reject(e instanceof Error ? e : new Error("Ошибка Meta."));
              }
            })();
          },
          {
            config_id: start.configId,
            response_type: "code",
            override_default_response_type: true,
            ...(platform === "whatsapp"
              ? {
                  extras: {
                    setup: {},
                    featureType: "whatsapp_embedded_signup",
                    sessionInfoVersion: "3",
                  },
                }
              : {}),
          },
        );
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось подключить Meta.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function selectIg(candidate: {
    pageId: string;
    pageName: string;
    igUserId: string;
    igUsername: string | null;
    accessToken: string;
  }) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(base + "/meta/callback", {
        method: "POST",
        body: JSON.stringify({
          action: "instagram_select",
          pageId: candidate.pageId,
          igUserId: candidate.igUserId,
          accessToken: candidate.accessToken,
          igUsername: candidate.igUsername,
          pageName: candidate.pageName,
        }),
      });
      setIgCandidates([]);
      setNotice(
        "Instagram подключён. Нажмите «Запустить приём», чтобы активировать webhook.",
      );
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выбрать аккаунт.",
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!event.origin.includes("facebook.com")) return;
      try {
        const data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          (
            window as unknown as {
              __sotyWaSession?: {
                wabaId?: string;
                phoneNumberId?: string;
              };
            }
          ).__sotyWaSession = {
            wabaId: data.data.waba_id || data.data.wabaId,
            phoneNumberId:
              data.data.phone_number_id || data.data.phoneNumberId,
          };
        }
      } catch {
        /* ignore non-JSON postMessage */
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="connections-page">
      <header>
        <h1>Подключения</h1>
        <p>Один бот бизнеса для заявок, общения и онлайн-записи.</p>
      </header>
      {error && !confirmation && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="account-notice">
          {notice}
        </p>
      )}
      <div className="connections-grid" style={{ display: "grid", gap: "var(--space-4)" }}>
        {(["telegram", "vk"] as const).map((platform) => {
          const connection = connections.find((c) => c.platform === platform);
          return (
            <article className="connection-item" key={platform}>
              <div className="connection-item__header">
                <div className="connection-item__icon platform-icon platform-icon--{platform}">
                  <b>{platform === "telegram" ? "TG" : "VK"}</b>
                </div>
                <div className="connection-item__info">
                  <div className="connection-item__name">
                    {platform === "telegram" ? "Telegram" : "ВКонтакте"}
                  </div>
                  {connection ? (
                    <div className="connection-item__status">
                      <span
                        className={`connection-item__status-dot connection-item__status-dot--${connection.status}`}
                      />
                      <span
                        className={`connection-item__status-text connection-item__status-text--${connection.status}`}
                      >
                        {connection.status === "connected"
                          ? "Подключён"
                          : connection.status === "pending"
                          ? "Ожидает"
                          : connection.status === "error"
                          ? "Ошибка"
                          : "Отключён"}
                      </span>
                      {connection.runtimeStatus && (
                        <span className="connection-item__runtime">
                          {connection.runtimeStatus === "ready"
                            ? "● Работает"
                            : connection.runtimeStatus === "error"
                            ? "⚠ Ошибка запуска"
                            : "○ Остановлен"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="connection-item__status">
                      <span className="connection-item__status-dot connection-item__status-dot--disconnected" />
                      <span className="connection-item__status-text connection-item__status-text--disconnected">Не подключён</span>
                    </span>
                  )}
                </div>
              </div>
              {connection && connection.status === "connected" ? (
                <div className="connection-item__actions">
                  <Link className="connection-item__action" href="/solutions">
                    Настроить решения
                  </Link>
                  {connection.runtimeStatus === "ready" ? (
                    <button
                      className="connection-item__action"
                      disabled={busy}
                      onClick={() => void act(platform, "stop")}
                    >
                      Остановить бота
                    </button>
                  ) : (
                    <button
                      className="connection-item__action connection-item__action--primary"
                      disabled={busy}
                      onClick={() => void act(platform, "start")}
                    >
                      Запустить бота
                    </button>
                  )}
                  <button
                    className="connection-item__action connection-item__action--danger"
                    disabled={busy}
                    aria-haspopup="dialog"
                    aria-expanded={confirmation === platform}
                    onClick={() => setConfirmation(platform)}
                  >
                    Отключить
                  </button>
                </div>
              ) : (
                <form
                  className="connection-token-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(platform, "connect");
                  }}
                >
                  <p>
                    {platform === "telegram" ? (
                      <>
                        Получите токен своего бота в{" "}
                        <a
                          href="https://t.me/BotFather"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          @BotFather
                        </a>
                        .
                      </>
                    ) : (
                      "Создайте ключ доступа сообщества VK с правами сообщений и управления. Включите сообщения сообщества в настройках VK."
                    )}
                  </p>
                  <label htmlFor={"token-" + platform}>
                    Токен {platform === "telegram" ? "бота" : "сообщества"}
                  </label>
                  <input
                    id={"token-" + platform}
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={tokens[platform]}
                    onChange={(e) =>
                      setTokens({ ...tokens, [platform]: e.target.value })
                    }
                    disabled={busy}
                  />
                  <p>Токен хранится на сервере в зашифрованном виде.</p>
                  <button className="button button--primary" disabled={busy}>
                    {busy ? "Проверяем…" : "Подключить"}
                  </button>
                </form>
              )}
            </article>
          );
        })}
        {(["whatsapp", "instagram"] as const).map((platform) => {
          const connection = connections.find((c) => c.platform === platform);
          const ready =
            platform === "whatsapp"
              ? metaStatus?.whatsappEmbeddedSignupReady
              : metaStatus?.instagramLoginReady;
          const configured = Boolean(metaStatus?.configured);
          return (
            <article className="connection-item" key={platform}>
              <div className="connection-item__header">
                <div className="connection-item__icon platform-icon platform-icon--{platform}">
                  <b>{platform === "whatsapp" ? "WA" : "IG"}</b>
                </div>
                <div className="connection-item__info">
                  <div className="connection-item__name">
                    {platformLabel(platform as Platform)}
                  </div>
                  {connection && connection.status === "connected" ? (
                    <div className="connection-item__status">
                      <span className="connection-item__status-dot connection-item__status-dot--connected" />
                      <span className="connection-item__status-text connection-item__status-text--connected">Подключён</span>
                      {connection.runtimeStatus === "ready" ? (
                        <>
                          <span className="connection-item__runtime">● Работает</span>
                        </>
                      ) : (
                        <>
                          <span className="connection-item__runtime connection-item__runtime--pending">○ Остановлен</span>
                        </>
                      )}
                    </div>
                  ) : !configured || !ready ? (
                    <div className="connection-item__status">
                      <span className="connection-item__status-dot connection-item__status-dot--pending" />
                      <span className="connection-item__status-text connection-item__status-text--pending">Требуется настройка Meta</span>
                    </div>
                  ) : (
                    <div className="connection-item__status">
                      <span className="connection-item__status-dot connection-item__status-dot--disconnected" />
                      <span className="connection-item__status-text connection-item__status-text--disconnected">Не подключён</span>
                    </div>
                  )}
                </div>
              </div>
              {connection && connection.status === "connected" ? (
                <div className="connection-item__actions">
                  <button
                    className="connection-item__action connection-item__action--primary"
                    disabled={busy}
                    onClick={() => void metaStart(platform)}
                  >
                    Запустить приём
                  </button>
                  <button
                    className="connection-item__action"
                    disabled={busy}
                    onClick={() => void connectMeta(platform)}
                  >
                    Переподключить
                  </button>
                  <button
                    className="connection-item__action connection-item__action--danger"
                    disabled={busy}
                    aria-haspopup="dialog"
                    aria-expanded={confirmation === platform}
                    onClick={() => setConfirmation(platform)}
                  >
                    Отключить
                  </button>
                </div>
              ) : !configured || !ready ? (
                <div className="connection-item__actions">
                  <button className="connection-item__action connection-item__action--primary" disabled>
                    Подключить
                  </button>
                </div>
              ) : (
                <div className="connection-item__actions">
                  <button
                    className="connection-item__action connection-item__action--primary"
                    disabled={busy}
                    onClick={() => void connectMeta(platform)}
                  >
                    {busy ? "Подключаем…" : "Подключить"}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {igCandidates.length > 0 && (
        <section className="panel connection-setup" aria-label="Выбор Instagram">
          <h2>Выберите Instagram</h2>
          <ul className="crm-list">
            {igCandidates.map((c) => (
              <li key={c.igUserId}>
                <button
                  className="button button--outline"
                  disabled={busy}
                  onClick={() => void selectIg(c)}
                >
                  {c.igUsername ? `@${c.igUsername}` : c.pageName} · {c.pageName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {confirmation ? (
        <dialog
          ref={dialogRef}
          className="sign-out-dialog"
          aria-labelledby={confirmTitleId}
          aria-describedby={confirmDescId}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setConfirmation(null);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !busy)
              setConfirmation(null);
          }}
        >
          <div className="sign-out-dialog__inner">
            <h2 id={confirmTitleId}>
              Отключить {platformLabel(confirmation as Platform)}?
            </h2>
            <p id={confirmDescId}>
              Приём и отправка сообщений остановятся. Для повторного подключения
              понадобится авторизация заново.
            </p>
            {error ? (
              <p className="account-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="sign-out-dialog__actions">
              <button
                ref={cancelRef}
                type="button"
                className="button button--outline"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                Назад
              </button>
              <button
                type="button"
                className="button button--primary sign-out-dialog__confirm"
                disabled={busy}
                onClick={() =>
                  void (confirmation === "telegram" || confirmation === "vk"
                    ? act(confirmation, "disconnect")
                    : metaDisconnect(confirmation))
                }
              >
                {busy ? "Отключаем…" : "Да, отключить"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
