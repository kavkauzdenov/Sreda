/**
 * Оценка следующего действия и покрытия исследования (§23, §24, §37, §70).
 *
 * Вопрос, на который отвечает этот модуль: «Что даст нам следующая операция?».
 * Без ответа агент превращается в краулер, который одинаково упорно ползает
 * по всем классам запросов, пока не кончится бюджет.
 *
 * Формула намеренно прозрачна и детерминирована — её можно объяснить
 * пользователю и воспроизвести в тестах.
 */

import type { OsintResearchOutcome, OsintResearchPurpose } from "../schema.ts";
import { identityConfidence, type BusinessIdentity } from "./identity.ts";

export type ActionSignals = {
  purpose: OsintResearchPurpose;
  /** Насколько цель действия связана с тем, что мы уже доказанно знаем. */
  identityRelevance: number;
  /** Насколько вероятно, что действие что-то добавит. */
  expectedInformationGain: number;
  /** Насколько надёжен источник, через который пойдёт действие. */
  sourceReliability: number;
  /** Насколько это новое — повторяющееся почти ничего не даёт. */
  novelty: number;
  /** Стоимость в условных единицах запроса. */
  cost: number;
  /** Доля уже известного в выдаче по этому направлению. */
  duplication: number;
};

export type ScoredAction = ActionSignals & {
  priority: number;
  /** Человекочитаемое объяснение: почему это действие сейчас. */
  explanation: string;
};

const PURPOSE_BASE_GAIN: Record<OsintResearchPurpose, number> = {
  // Опознание — фундамент: без него всё остальное невозможно проверить.
  identity: 1,
  website: 0.95,
  contact: 0.9,
  maps: 0.75,
  social: 0.7,
  // Подтверждение и контакты важнее широких обзорных веток.
  locations: 0.65,
  legal: 0.6,
  verification: 0.6,
  reviews: 0.55,
  mentions: 0.5,
  // Дальше — обогащение картины.
  services: 0.45,
  products: 0.45,
  prices: 0.4,
  vacancies: 0.4,
  changes: 0.4,
  reputation: 0.4,
  news: 0.35,
  competitors: 0.3,
};

/** Стоимость: один обычный запрос недорог, обход сети — дорог. */
export const PURPOSE_COST: Record<OsintResearchPurpose, number> = {
  identity: 1,
  website: 1,
  contact: 1,
  maps: 1,
  social: 1,
  locations: 1,
  legal: 1,
  verification: 1,
  reviews: 1,
  mentions: 1,
  services: 1,
  products: 1,
  prices: 1,
  vacancies: 1,
  changes: 1,
  reputation: 1,
  news: 1,
  competitors: 1,
};

/**
 * Приоритет действия.
 *
 * Ожидаемая отдача минус стоимость и минус дублирование. Диапазон
 * намеренно широкий — это порядок, а не абсолютная величина.
 */
export function scoreAction(signals: ActionSignals): ScoredAction {
  const gain = PURPOSE_BASE_GAIN[signals.purpose] * signals.expectedInformationGain;
  const value =
    signals.identityRelevance * 1.2 +
    gain * 2 +
    signals.sourceReliability * 0.8 +
    signals.novelty * 1 +
    signals.expectedInformationGain * 0.6;
  const penalty =
    PURPOSE_COST[signals.purpose] * signals.cost * 0.8 + signals.duplication * 3;
  const priority = Math.round((value - penalty) * 100) / 100;

  const explanation = buildExplanation(signals);
  return { ...signals, priority, explanation };
}

function buildExplanation(signals: ActionSignals): string {
  const parts: string[] = [];
  if (signals.identityRelevance >= 0.8) parts.push("опирается на подтверждённые данные");
  else if (signals.identityRelevance <= 0.3) parts.push("ищет первичное опознание");
  if (signals.novelty <= 0.2) parts.push("похоже на уже изученное направление");
  if (signals.duplication >= 0.5) parts.push("значительная доля повторов в выдаче");
  if (signals.sourceReliability <= 0.3) parts.push("источник ненадёжен");
  if (parts.length === 0) parts.push("ожидаем новое знание по этому направлению");
  return parts.join(", ");
}

/**
 * Оценка новизны по результату прошлых действий этого же назначения.
 *
 * `recentOutcomes` — последние исходы в этой ветке, от новых к старым.
 * Доля «пусто» и «дубликат» определяет, насколько ветка насытилась.
 */
export function noveltyFor(outcomes: readonly OsintResearchOutcome[]): number {
  if (outcomes.length === 0) return 1;
  let productive = 0;
  for (const outcome of outcomes) {
    if (outcome === "productive") productive += 1;
  }
  return productive / outcomes.length;
}

/** Доля повторов: бессмысленно искать то, что уже найдено. */
export function duplicationFor(
  outcomes: readonly OsintResearchOutcome[],
): number {
  if (outcomes.length === 0) return 0;
  let duplicates = 0;
  for (const outcome of outcomes) {
    if (outcome === "duplicate" || outcome === "empty") duplicates += 1;
  }
  return duplicates / outcomes.length;
}

/**
 * Релевантность действия для текущего состояния идентичности.
 *
 * Пока бизнес не опознан (есть только имя), почти всё релевантно. Когда
 * телефон найден, поиск контактов теряет смысл — он уже есть, и на его место
 * приходят проверки и подтверждения.
 */
export function relevanceFor(
  identity: BusinessIdentity,
  purpose: OsintResearchPurpose,
  hasConfirmed: Record<OsintResearchPurpose, boolean>,
): number {
  const confidence = identityConfidence(identity);
  if (purpose === "identity") return confidence < 0.8 ? 1 : 0.3;
  if (purpose === "contact" && hasConfirmed.contact) return 0.25;
  if (purpose === "website" && hasConfirmed.website) return 0.35;
  if (purpose === "social" && hasConfirmed.social) return 0.4;
  if (purpose === "legal" && hasConfirmed.legal) return 0.3;
  return 0.4 + confidence * 0.4;
}

/* ------------------------------------------------------------------ */
/* Покрытие и насыщение (§37, §70, §72)                                */
/* ------------------------------------------------------------------ */

export type CoverageDimension = {
  key: string;
  label: string;
  /** 0..1. Никогда не 1.0 «просто потому что». */
  level: number;
  /** Что мешает довести: недоступные источники, нехватка бюджета и т. п. */
  blockers: string[];
};

export type CoverageReport = {
  dimensions: CoverageDimension[];
  /** Общий уровень — средневзвешенное, НЕ «процент полноты». */
  overall: number;
  /** Что исследовано. */
  covered: string[];
  /** Чего мы не знаем — обязательный раздел, а не пустота. */
  unknown: string[];
  /** Исследование насыщается: новой информации почти нет. */
  saturating: boolean;
};

export const DIMENSION_LABELS: Record<string, string> = {
  identity: "Идентичность",
  website: "Сайт",
  contacts: "Контакты",
  social: "Соцсети",
  reviews: "Отзывы",
  legal: "Юридическое лицо",
  mentions: "Упоминания",
  locations: "Филиалы",
  news: "Публикации",
  vacancies: "Вакансии",
};

/**
 * Строит отчёт о покрытии.
 *
 * Ключевой момент: покрытие НЕ выводится из «сколько страниц скачали».
 * Оно отражает, сколько направлений исследования дало подтверждённое
 * знание, и честно перечисляет то, что осталось неизвестным.
 */
export function evaluateCoverage(input: {
  /** Направление → есть ли подтверждённые факты. */
  confirmed: Partial<Record<string, boolean>>;
  /** Направление → почему не подтверждено. */
  blockers: Partial<Record<string, string[]>>;
  /** Сколько последних действий не дали нового знания. */
  barrenActions: number;
  /** Есть ли исчерпанные/недоступные ветки. */
  exhausted: boolean;
  budgetExhausted: boolean;
}): CoverageReport {
  const keys = Object.keys(DIMENSION_LABELS);
  const dimensions: CoverageDimension[] = keys.map((key): CoverageDimension => {
    const label = DIMENSION_LABELS[key] ?? key;
    const isConfirmed = input.confirmed[key] === true;
    const blockers = input.blockers[key] ?? [];
    // Подтверждённое направление закрыто. Неподтверждённое — частично,
    // если мы хотя бы знаем, чем оно заблокировано: это прогресс.
    const level = isConfirmed ? 1 : blockers.length > 0 ? 0.25 : 0;
    return {
      key,
      label,
      level,
      blockers,
    };
  });

  const active = dimensions.filter((entry) => entry.level > 0 || entry.blockers.length > 0);
  const denominator = active.length > 0 ? active.length : dimensions.length;
  const overall =
    dimensions.reduce((sum, entry) => sum + entry.level, 0) / denominator;

  const covered = dimensions
    .filter((entry) => entry.level === 1)
    .map((entry) => entry.label);
  const unknown = dimensions
    .filter((entry) => entry.level < 1)
    .map((entry) => entry.label);

  // Насыщение: подряд идущие действия без нового знания — сигнал, что мы
  // топчемся на месте. Не «исследование завершено», а «продолжать бессмысленно».
  const saturating =
    input.barrenActions >= 8 ||
    (input.exhausted && input.barrenActions >= 4) ||
    (input.budgetExhausted && input.barrenActions >= 2);

  return {
    dimensions,
    overall: Math.round(overall * 1000) / 1000,
    covered,
    unknown,
    saturating,
  };
}

/**
 * Причина остановки исследования (§72). Агент обязан уметь остановиться
 * и честно сказать почему — иначе он либо крутится вечно, либо врёт.
 */
export type StopReason =
  | "budget_exhausted"
  | "coverage_sufficient"
  | "no_useful_actions"
  | "information_gain_exhausted"
  | null;

export function decideStop(input: {
  budgetExhausted: boolean;
  pendingActions: number;
  barrenActions: number;
  coverage: CoverageReport;
}): StopReason {
  if (input.budgetExhausted) return "budget_exhausted";
  if (input.pendingActions === 0) {
    return input.coverage.saturating
      ? "information_gain_exhausted"
      : "no_useful_actions";
  }
  if (input.coverage.saturating && input.pendingActions <= 2) {
    return "information_gain_exhausted";
  }
  return null;
}

export const STOP_REASON_LABELS: Record<NonNullable<StopReason>, string> = {
  budget_exhausted: "Исчерпан бюджет исследования",
  coverage_sufficient: "Основные источники найдены",
  no_useful_actions: "Нет действий, способных дать новое знание",
  information_gain_exhausted: "Исследование насыщается",
};
