/**
 * Обратная связь: противоречие → исследовательская гипотеза (§8).
 *
 * Stage 4 уже умеет обнаруживать конфликт (два разных значения одного поля
 * из независимых источников) и принципиально НЕ выбирает победителя. Это
 * правильно, но без обратной связи конфликт просто лежит в таблице.
 *
 * Здесь конфликт превращается в вопрос: «какой адрес актуален и почему их
 * два?». Гипотеза ищет независимые свидетельства и учитывает:
 *   - авторитетность источника;
 *   - дату наблюдения и, если известна, дату публикации;
 *   - независимость источников (два независимых сильнее, чем два копии);
 *   - согласие с уже подтверждёнными фактами;
 *   - возможность исторической смены значения.
 *
 * Чего модуль НЕ делает: не выбирает «правильное» значение. Частота
 * упоминания не является доказательством, и если свидетельств не хватает,
 * конфликт остаётся открытым.
 */

import type { Hypothesis } from "./hypothesis.ts";

export type ContradictionSide = {
  value: string;
  sources: { id: string; name: string; url: string }[];
  observations: string[];
  firstSeen: string;
  lastSeen: string;
};

export type Contradiction = {
  id: string;
  business_id: string;
  fact_type: string;
  sides: unknown;
  value_count: number;
  source_count: number;
  status: "unresolved" | "resolved";
  detected_at: Date;
  updated_at: Date;
};

/** Типы фактов, где конфликт действительно что-то значит. */
const MEANINGFUL: Record<string, string> = {
  business_name: "название",
  phone: "телефон",
  address: "адрес",
  website: "сайт",
  domain: "домен",
  legal_name: "юридическое наименование",
  tax_identifier: "ИНН",
  registration_identifier: "регистрационный номер",
  city: "город",
  region: "регион",
  postal_code: "индекс",
  category: "категория",
};

/** Как много мы знаем о каждой стороне конфликта. */
export type SideEvidence = {
  /** Максимальная авторитетность источника этой стороны. */
  authority: number;
  /** Сколько независимых источников за эту сторону. */
  independentSources: number;
  /** Самая свежая дата наблюдения. */
  lastSeen: string | null;
  /** Есть ли дата публикации — она весомее даты наблюдения. */
  publishedAt: string | null;
};

/**
 * Оценка свидетельства стороны.
 *
 * Источники одного сайта не независимы: пять страниц одного каталога —
 * это одно свидетельство, а не пять. Независимость считается по
 * нормализованному домену источника.
 */
export function assessSide(side: ContradictionSide): SideEvidence {
  const domains = new Set<string>();
  let authority = 0;
  for (const source of side.sources ?? []) {
    try {
      const host = new URL(source.url).hostname.replace(/^www\./, "");
      // Разные поддомены одного сайта — тот же источник для наших целей.
      const registrable = host.split(".").slice(-2).join(".");
      domains.add(registrable);
    } catch {
      domains.add(source.id);
    }
    const trust = (source.name ?? "").toLowerCase();
    if (trust.includes("официальн") || trust.includes("official")) authority = 1;
    else if (trust.includes("карт") || trust.includes("каталог") || trust.includes("2гис")) {
      authority = Math.max(authority, 0.6);
    }
  }
  const lastSeen =
    side.lastSeen && side.lastSeen.length > 0 ? side.lastSeen : null;
  return {
    authority,
    independentSources: domains.size,
    lastSeen,
    publishedAt: null,
  };
}

/**
 * Итоговая оценка конфликта. Возвращает НЕ победителя, а понимание,
 * достаточно ли свидетельств, чтобы сузить круг, и что именно проверять.
 */
export type ConflictAssessment = {
  /** Достаточно свидетельств, чтобы сузить круг (но не чтобы выбрать). */
  narrowed: boolean;
  /** Сторона с заметно более сильным свидетельством — кандидат на актуальность. */
  likelyCurrent: { value: string; reason: string } | null;
  /** Почему данных недостаточно — объяснение для пользователя и audit. */
  insufficient: string;
};

/**
 * Оценивает конфликт. Победителя не выбирает: максимум, что делает модуль,
 * это указать сторону, у которой свидетельства заметно сильнее, и сказать,
 * чего именно не хватает для уверенного вывода.
 */
export function assessConflict(sides: ContradictionSide[]): ConflictAssessment {
  if (sides.length < 2) {
    return {
      narrowed: false,
      likelyCurrent: null,
      insufficient: "Конфликт не зафиксирован: значений меньше двух",
    };
  }

  const assessed = sides.map((side) => ({ side, evidence: assessSide(side) }));

  // Оценка в ЦЕЛЫХ баллах, а не в дробях. С дробями порог сравнения
  // зависел от ошибок округления: 1.4 - 0.9 = 0.4999... и «очевидное»
  // преимущество в свидетельствах молча считалось равным.
  const rank = (evidence: SideEvidence): number => {
    // Первичный (официальный) источник — качественно другое свидетельство,
    // чем каталог: его вес поэтому заметно выше. Иначе два каталога,
    // цитирующие одно и то же, «перевесили» бы сайт самой компании.
    const authorityPoints = evidence.authority >= 1 ? 4 : evidence.authority > 0 ? 1 : 0;
    return (
      authorityPoints +
      Math.min(evidence.independentSources, 3) +
      (evidence.lastSeen ? 1 : 0)
    );
  };

  const ranked = [...assessed].sort((a, b) => rank(b.evidence) - rank(a.evidence));
  // sides.length >= 2 проверено выше, поэтому ranked[0] существует.
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  const lowestAuthority = ranked[ranked.length - 1]!.evidence.authority;

  // Все источники одинакового уровня и независимых нет — данные равноценны.
  const allSameAuthority = ranked.every((entry) => entry.evidence.authority === lowestAuthority);
  const topIndependent = top.evidence.independentSources;
  if (allSameAuthority && topIndependent < 2) {
    return {
      narrowed: false,
      likelyCurrent: null,
      insufficient:
        "Источники равноценны и не независимы — выбрать актуальное значение нельзя",
    };
  }

  // Недостаток в ОДИН балл — это не разрыв, а шум. Два независимых
  // источника против одного (3 против 2) конфликт не разрешают: для этого
  // нужен ещё один независимый источник или авторитетный.
  const gap = runnerUp ? rank(top.evidence) - rank(runnerUp.evidence) : Infinity;
  if (gap < 2) {
    return {
      narrowed: false,
      likelyCurrent: null,
      insufficient:
        "Свидетельства сторон сопоставимы — нужен ещё один независимый источник",
    };
  }

  const topEvidence = top.evidence;
  const reasons: string[] = [];
  if (topEvidence.authority >= 1) reasons.push("источник авторитетный");
  if (topEvidence.independentSources >= 2) reasons.push("несколько независимых источников");
  if (topEvidence.lastSeen) reasons.push("есть дата наблюдения");

  return {
    narrowed: true,
    likelyCurrent: {
      value: top.side.value,
      reason: reasons.join(", ") || "больше свидетельств",
    },
    insufficient:
      "Даже с сужением круга актуальность не доказана: возможна историческая смена значения",
  };
}

/**
 * Строит гипотезу о конфликте.
 *
 * Единственная цель — получить независимые свидетельства. Мы не ищем
 * «правильное значение», мы ищем данные, которые позволят сузить круг.
 */
export function hypothesisFromContradiction(contradiction: {
  id: string;
  fact_type: string;
  sides: unknown;
  value_count: number;
  source_count: number;
}): Hypothesis[] {
  const sides = parseSides(contradiction.sides);
  if (sides.length < 2) return [];

  const fieldLabel = MEANINGFUL[contradiction.fact_type];
  if (!fieldLabel) return [];

  const assessment = assessConflict(sides);
  const values = sides.map((side) => side.value).filter(Boolean);

  const out: Hypothesis[] = [
    {
      type: "contradiction",
      statement: `Уточняем, какой ${fieldLabel} актуален`,
      reason:
        `Источники расходятся по полю «${fieldLabel}» (${values.join(" / ")}). ` +
        `Победителя не выбираем: ищем независимые свидетельства. ` +
        assessment.insufficient,
      purpose: "verification",
      // Конфликт — сильный повод копать: он дешевле, чем одиночная проверка,
      // потому что у нас уже есть две расходящиеся версии.
      priority: assessment.narrowed ? 88 : 84,
      confidence: 0.5,
      subjectKey: "contradiction",
      subjectValue: contradiction.fact_type,
      // Ключ по id: конфликт обновляется на месте, и рост числа значений —
      // это уточнение того же вопроса, а не новый вопрос.
      dedupeKey: `contradiction:${contradiction.id}:resolve`,
    },
    {
      type: "changes",
      statement: `Проверяем историю изменения ${fieldLabel}`,
      reason:
        `Расхождение по полю «${fieldLabel}» может быть исторической сменой, ` +
        `а не ошибкой. Ищем, менялось ли это значение публично.`,
      purpose: "changes",
      priority: 76,
      confidence: 0.4,
      subjectKey: "contradiction",
      subjectValue: `${contradiction.fact_type}:history`,
      dedupeKey: `contradiction:${contradiction.id}:history`,
    },
  ];

  return out;
}

/**
 * Стороны приходят из jsonb: это недоверенная форма, поэтому разбираем её
 * осторожно и молча отбрасываем мусор вместо падения.
 */
export function parseSides(raw: unknown): ContradictionSide[] {
  if (!Array.isArray(raw)) return [];
  const out: ContradictionSide[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = (entry as { value?: unknown }).value;
    if (typeof value !== "string" || value.length === 0) continue;
    const sources = Array.isArray((entry as { sources?: unknown }).sources)
      ? ((entry as { sources: unknown[] }).sources
          .map((source) => {
            if (typeof source !== "object" || source === null) return null;
            const record = source as { id?: unknown; name?: unknown; url?: unknown };
            return {
              id: String(record.id ?? ""),
              name: String(record.name ?? ""),
              url: String(record.url ?? ""),
            };
          })
          .filter((source): source is { id: string; name: string; url: string } =>
            Boolean(source && source.id),
          ) ?? [])
      : [];
    const row = entry as { observations?: unknown; firstSeen?: unknown; lastSeen?: unknown };
    out.push({
      value,
      sources,
      observations: Array.isArray(row.observations)
        ? row.observations.map((item) => String(item))
        : [],
      firstSeen: typeof row.firstSeen === "string" ? row.firstSeen : "",
      lastSeen: typeof row.lastSeen === "string" ? row.lastSeen : "",
    });
  }
  return out;
}
