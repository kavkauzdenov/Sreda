"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/apiClient";
import {
  channelDisplayStatus,
  type ChannelConnectionLike,
} from "@/lib/ordersChannelStatus";

type ConnectionRow = ChannelConnectionLike & { platform: string };

export function OrderChannelSettings({ businessId }: { businessId: string }) {
  const [rows, setRows] = useState<ConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void apiRequest<ConnectionRow[]>(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/connections`,
    )
      .then((data) => {
        if (alive) setRows(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (alive) setRows([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  function rowFor(platform: string) {
    return rows.find((r) => r.platform === platform);
  }

  function renderChannel(platform: "telegram" | "vk", title: string) {
    const conn = rowFor(platform);
    const display = channelDisplayStatus(conn);
    return (
      <li>
        <strong>{title}</strong>
        <span data-testid={`settings-channel-status-${platform}`}>
          {display.label}
        </span>
        <Link className="button button--outline" href="/connections">
          {display.cta}
        </Link>
      </li>
    );
  }

  return (
    <fieldset className="orders-settings__section">
      <legend>Каналы</legend>
      <p className="account-footnote">
        Токены и запуск настраиваются в разделе «Подключения». Здесь статус
        подключения и runtime.
      </p>
      {loading ? (
        <p className="account-footnote">Проверяем каналы…</p>
      ) : (
        <ul className="orders-channel-status">
          {renderChannel("telegram", "Telegram")}
          {renderChannel("vk", "VK")}
        </ul>
      )}
      <p className="account-footnote">
        Известное ограничение: переключатели «Мои заказы» и комментарии клиента в
        боте пока не вынесены в этот экран — используются серверные настройки
        отмены и каналы Connections.
      </p>
    </fieldset>
  );
}
