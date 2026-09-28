/** Shared Orders channel readiness labels (Telegram / VK). */

export type ChannelConnectionLike = {
  platform?: string;
  status: string;
  runtimeStatus?: string | null;
};

export type ChannelDisplayStatus = {
  label: string;
  ready: boolean;
  cta: string;
};

/**
 * Distinguish saved token vs live bot runtime.
 * channelOk / ready only when status=connected AND runtimeStatus=ready.
 */
export function channelDisplayStatus(
  conn: ChannelConnectionLike | null | undefined,
): ChannelDisplayStatus {
  if (!conn || conn.status !== "connected") {
    return {
      label: "Не подключено",
      ready: false,
      cta: "Подключить",
    };
  }
  if (conn.runtimeStatus === "ready") {
    return {
      label: "Работает",
      ready: true,
      cta: "Открыть подключения",
    };
  }
  if (conn.runtimeStatus === "error") {
    return {
      label: "Ошибка запуска",
      ready: false,
      cta: "Запустить / Настроить",
    };
  }
  // pending / null / unknown while token exists
  return {
    label: "Подключено, не запущено",
    ready: false,
    cta: "Запустить / Настроить",
  };
}

export function isChannelRuntimeReady(
  conn: ChannelConnectionLike | null | undefined,
): boolean {
  return channelDisplayStatus(conn).ready;
}
