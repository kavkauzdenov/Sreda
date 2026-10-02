import type { DiscoveryIntent } from "../config.ts";
import type { OsintSourceType } from "../schema.ts";
import type { GeneratedQuery } from "../queries.ts";
import type { DiscoveryProfile } from "../profile.ts";
import type { ParsedPage } from "../extraction/page.ts";

/**
 * Контракт OSINT-провайдера (§13). Провайдер возвращает СЫРЫЕ результаты —
 * нормализация, классификация и scoring выполняются вызывающей стороной.
 * Запрещено: обход авторизации/CAPTCHA/paywall; только публичные endpoint'ы
 * или официальные API с учётом лимитов.
 */

export type ProviderSearchInput = {
  query: GeneratedQuery;
  profile: DiscoveryProfile;
  limit: number;
  /** Отмена по таймауту бюджета discovery run'а. */
  signal?: AbortSignal;
};

export type ProviderSearchResult = {
  url: string;
  title?: string | null;
  snippet?: string | null;
  position?: number | null;
  /** Идентификатор карточки у источника (2GIS org id и т.п.). */
  externalId?: string | null;
  publishedAt?: string | null;
};

export type ProviderSearchOutput = {
  results: ProviderSearchResult[];
};

/** Как провайдер получает данные: только разрешённые способы. */
export type ProviderPolicy =
  | "official_api"
  | "search_api"
  | "structured_data"
  | "public_web"
  | "disabled";

/**
 * Доступность провайдера в этом окружении: VK API без токена, недоступный
 * по конфигу провайдер — исключается из выборки и виден в snapshot'е.
 */
export type ProviderAvailability =
  | { available: true }
  | { available: false; reason: string };

export type ProviderDescriptor = {
  id: string;
  label: string;
  /** Какие типы источников умеет выдавать (для отчёта и аудита). */
  types: OsintSourceType[];
  /** Какие интенты запросов умеет обслуживать. */
  intents: DiscoveryIntent[];
  /** false — источник не требует сети (fixtures/локальные данные). */
  requiresNetwork: boolean;
  /** Поставлен ли в enabled по умолчанию (без учёта БД). */
  enabledByDefault: boolean;
  policy: ProviderPolicy;
  /** Насколько часто разрешён вызов (в DiscoveryBudget на run). */
  rateLimitPerMinute: number;
  documentationUrl?: string;
};

export type OsintProvider = {
  descriptor: ProviderDescriptor;
  search(input: ProviderSearchInput): Promise<ProviderSearchOutput>;
  /** Динамическая доступность; без метода — считается доступным. */
  availability?: () => ProviderAvailability;
};

export type PageFetchInput = {
  url: string;
  signal?: AbortSignal;
  /** Ограничение на размер тела (байты); по умолчанию — у провайдера. */
  maxBytes?: number;
  timeoutMs?: number;
};

export type PageFetchOutput =
  | { ok: true; page: ParsedPage }
  | { ok: false; reason: string; detail?: string };

/**
 * Провайдер «загрузка конкретной страницы» для crawl-фазы (§25):
 * контракт единый для HTTP-провайдера и официальных API, возвращающих
 * документы (будущие 2GIS/поисковые index'ы).
 */
export type OsintPageProvider = {
  descriptor: ProviderDescriptor;
  fetchPage(input: PageFetchInput): Promise<PageFetchOutput>;
  availability?: () => ProviderAvailability;
};
