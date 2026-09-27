"use client";

export function ClientDuplicateCard({
  summary,
  canMerge,
  onOpen,
}: {
  summary: {
    count: number;
    candidates: { id: string; name: string; matches: string[] }[];
  };
  canMerge?: boolean;
  onOpen: () => void;
}) {
  if (!summary.count || !summary.candidates.length) return null;
  const first = summary.candidates[0]!;
  const matchLabels = first.matches.map((m) =>
    m === "phone"
      ? "Телефон"
      : m === "email"
        ? "Email"
        : m === "telegram"
          ? "Telegram"
          : m === "vk"
            ? "VK"
            : m === "whatsapp"
              ? "WhatsApp"
              : m === "instagram"
                ? "Instagram"
                : m,
  );
  return (
    <section className="client-overview__section client-duplicate-card">
      <h3>Возможные дубли</h3>
      <p>Возможно, это один клиент</p>
      <p>
        Совпадает: {matchLabels.join(", ")}
        {summary.count > 1 ? ` · ещё ${summary.count - 1}` : ""}
      </p>
      <p>
        <strong>{first.name}</strong>
      </p>
      <button type="button" className="button button--outline" onClick={onOpen}>
        Проверить
      </button>
      {canMerge === false ? (
        <p className="account-footnote">
          Объединение доступно владельцу и администратору.
        </p>
      ) : null}
    </section>
  );
}
