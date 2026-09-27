"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/apiClient";

type ConnectionRow = {
  platform: string;
  status: string;
};

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

  function statusOf(platform: string): string {
    const hit = rows.find((r) => r.platform === platform);
    if (!hit) return "Не подключено";
    if (hit.status === "connected") return "Подключено";
    return hit.status || "Не подключено";
  }

  return (
    <fieldset className="orders-settings__section">
      <legend>Каналы</legend>
      <p className="account-footnote">
        Токены и подключение настраиваются в разделе «Подключения». Здесь только
        статус.
      </p>
      {loading ? (
        <p className="account-footnote">Проверяем каналы…</p>
      ) : (
        <ul className="orders-channel-status">
          <li>
            <strong>Telegram</strong>
            <span>{statusOf("telegram")}</span>
            <Link className="button button--outline" href="/connections">
              Подключить
            </Link>
          </li>
          <li>
            <strong>VK</strong>
            <span>{statusOf("vk")}</span>
            <Link className="button button--outline" href="/connections">
              Подключить
            </Link>
          </li>
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
