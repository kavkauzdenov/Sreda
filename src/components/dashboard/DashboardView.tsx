"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { DashboardKpis } from "./DashboardKpis";
import { SolutionCards } from "./SolutionCards";
import { TodaySchedule } from "./TodaySchedule";
import { QuickActions } from "./QuickActions";
import { DashboardAiHint } from "./DashboardAiHint";
import { CommandSearch } from "./CommandSearch";
import { ActivityFeed } from "./ActivityFeed";
import { BusinessSwitcher } from "./BusinessSwitcher";
import { LoadingPanel } from "./LoadingPanel";
import { DetailDialog } from "./DetailDialog";
import { SolutionModule, solutionState } from "./SolutionModule";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { SetupChecklist } from "@/components/onboarding/SetupChecklist";
import {
  useDashboardData,
  type WorkspaceSolutionItem,
} from "@/hooks/useDashboardData";
import { formatRelativeDateTime } from "@/lib/format";
import { isDemoMode } from "@/lib/dataMode";
import { apiRequest } from "@/lib/apiClient";
import {
  resolveSetupSteps,
  setupStepsForIndustry,
  type SetupReadiness,
} from "@/lib/setupSteps";
import {
  recommendationSummary,
  recommendedSolutionCodes,
} from "@/lib/businessTypeRecommendations";
import { solutionRoute } from "@/config/solutionPresentation";
import {
  formatSolutionPrice,
  productSolutionByCode,
  productSolutionCta,
  productSolutionHref,
} from "@/lib/productSolutions";
import type { Lead, Post } from "@/types";
import { APP_NAME } from "@/config/brand";

type Selection =
  | { type: "catalog" }
  | { type: "solution"; item: WorkspaceSolutionItem }
  | { type: "lead"; item: Lead }
  | { type: "post"; item: Post };

export function DashboardView() {
  const data = useDashboardData();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionBusiness, setSelectionBusiness] = useState("");
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState("");
  const [profileHint, setProfileHint] = useState<{
    id: string;
    type: "store" | "service" | "hybrid";
  } | null>(null);
  const [industryHint, setIndustryHint] = useState<{
    id: string;
    industry: string | null;
    onboardingDone: boolean;
    progress: Record<string, boolean>;
    readiness: SetupReadiness;
  } | null>(null);

  useEffect(() => {
    if (!data.businessId || isDemoMode || data.isLoading) return;
    const businessId = data.businessId;
    let active = true;
    void apiRequest<{ business_type?: "store" | "service" | "hybrid" }>(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/profile`,
    )
      .then((profile) => {
        if (active)
          setProfileHint({
            id: businessId,
            type: profile.business_type ?? "hybrid",
          });
      })
      .catch(() => {
        if (active) setProfileHint(null);
      });
    return () => {
      active = false;
    };
  }, [data.businessId, data.isLoading]);

  useEffect(() => {
    if (!data.businessId || isDemoMode || data.isLoading) return;
    const businessId = data.businessId;
    let active = true;
    void apiRequest<{
      industry?: string | null;
      onboarding_completed_at?: string | null;
      setup_progress?: Record<string, boolean>;
      readiness?: SetupReadiness;
    }>(`/api/v1/businesses/${encodeURIComponent(businessId)}/industry`)
      .then((row) => {
        if (active)
          setIndustryHint({
            id: businessId,
            industry: row.industry ?? null,
            onboardingDone: !!row.onboarding_completed_at,
            progress: row.setup_progress ?? {},
            readiness: row.readiness ?? {},
          });
      })
      .catch(() => {
        if (active) setIndustryHint(null);
      });
    return () => {
      active = false;
    };
  }, [data.businessId, data.isLoading]);

  const businessType =
    !isDemoMode && profileHint?.id === data.businessId
      ? profileHint.type
      : null;
  const recommended = recommendedSolutionCodes(businessType);
  const recommendHint = recommendationSummary(businessType);
  const showIndustryNudge =
    !isDemoMode &&
    industryHint?.id === data.businessId &&
    !industryHint.industry &&
    !industryHint.onboardingDone;
  const setup = (() => {
    if (!industryHint || industryHint.id !== data.businessId) return null;
    if (industryHint.onboardingDone) return null;
    return resolveSetupSteps({
      steps: setupStepsForIndustry(industryHint.industry),
      progress: industryHint.progress,
      readiness: industryHint.readiness,
    });
  })();
  const setupSteps =
    setup && setup.done < setup.total
      ? { done: setup.done, total: setup.total }
      : null;
  const nextSetupHint = (() => {
    if (!industryHint?.industry || industryHint.onboardingDone) return null;
    const done = new Set(
      (setup?.steps ?? []).filter((s) => s.done).map((s) => s.id),
    );
    if (
      !done.has("schedule") &&
      ["beauty", "education", "rental", "sport_health", "automotive"].includes(
        industryHint.industry,
      )
    )
      return "Настройте расписание, чтобы открыть онлайн-запись.";
    if (!done.has("telegram"))
      return "Подключите Telegram, чтобы клиенты могли писать боту.";
    if (
      !done.has("catalog") &&
      ["retail", "food"].includes(industryHint.industry)
    )
      return "Заполните каталог товаров.";
    return "Продолжите настройку бизнеса.";
  })();

  const show = (value: Selection) => {
    setQuery("");
    setSelectionBusiness(data.businessId);
    setSelection(value);
  };
  const selectSolution = (item: WorkspaceSolutionItem) =>
    show({ type: "solution", item });
  const catalog = () => show({ type: "catalog" });

  async function connectSolution(code: string) {
    if (!data.businessId || isDemoMode || activating) return;
    setActivating(true);
    setActivateError("");
    try {
      await apiRequest(`/api/v1/businesses/${data.businessId}/solutions`, {
        method: "POST",
        body: JSON.stringify({ code, enabled: true }),
      });
      setSelection(null);
      data.retry();
      router.push(productSolutionHref("setup_required", code));
    } catch (e) {
      setActivateError(
        e instanceof Error ? e.message : "Не удалось подключить решение.",
      );
    } finally {
      setActivating(false);
    }
  }

  const term = query.trim().toLocaleLowerCase("ru-RU");
  const matchingSolutions = term
    ? data.workspaceItems.filter((item) =>
        `${item.solution.name} ${item.solution.description}`
          .toLocaleLowerCase("ru-RU")
          .includes(term),
      )
    : [];
  const matchingLeads = term
    ? data.leads.filter((item) =>
        `${item.name} ${item.message ?? ""}`
          .toLocaleLowerCase("ru-RU")
          .includes(term),
      )
    : [];
  const matchingPosts = term
    ? data.posts.filter((item) =>
        item.text.toLocaleLowerCase("ru-RU").includes(term),
      )
    : [];
  const resultCount =
    matchingSolutions.length + matchingLeads.length + matchingPosts.length;
  const selectedLead =
    selection?.type === "lead"
      ? data.leads.find((lead) => lead.id === selection.item.id)
      : undefined;
  const visibleSelection: Selection | null =
    selectionBusiness !== data.businessId || data.error || data.isLoading
      ? null
      : selection?.type === "lead"
        ? selectedLead
          ? { type: "lead", item: selectedLead }
          : null
        : selection;
  const dialogTitle =
    visibleSelection?.type === "catalog"
      ? `Что поручим БизнеСотам?`
      : visibleSelection?.type === "solution"
        ? visibleSelection.item.solution.name
        : visibleSelection?.type === "lead"
          ? "Заявка клиента"
          : "Предпросмотр публикации";

  return (
    <div className="dashboard-root biznesoty-dashboard">
      <div className="mobile-business-switcher">
        <BusinessSwitcher
          businesses={data.businesses}
          currentBusiness={data.business}
          onSelect={(id) => {
            setQuery("");
            setSelection(null);
            data.setBusinessId(id);
          }}
        />
      </div>

      {term && !data.isLoading && !data.error ? (
        <section
          className="search-results panel"
          aria-label="Результаты поиска"
          aria-live="polite"
        >
          <div className="panel-heading">
            <h2>Результаты поиска</h2>
            <span>{resultCount}</span>
          </div>
          {!resultCount && (
            <p className="empty-copy">
              Ничего не найдено в текущем рабочем пространстве.
            </p>
          )}
          {matchingSolutions.map((item) => (
            <button
              key={item.solution.id}
              onClick={() => {
                selectSolution(item);
                setQuery("");
              }}
            >
              <Search size={17} />
              <span>
                {item.solution.name}
                <small>Решение</small>
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
          {matchingLeads.map((item) => (
            <button key={item.id} onClick={() => show({ type: "lead", item })}>
              <Search size={17} />
              <span>
                {item.name}
                <small>{item.message}</small>
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
          {matchingPosts.map((item) => (
            <button key={item.id} onClick={() => show({ type: "post", item })}>
              <Search size={17} />
              <span>
                {item.text}
                <small>Публикация</small>
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </section>
      ) : null}

      {data.error ? (
        <section role="alert" className="panel load-error">
          <h1>Не получилось загрузить данные</h1>
          <p>{data.error}</p>
          <button
            className="button button--primary"
            onClick={() => {
              if (!data.business || !data.user) window.location.reload();
              else data.retry();
            }}
          >
            <RefreshCw size={18} />
            Попробовать ещё раз
          </button>
        </section>
      ) : (
        <>
          <header className="biznesoty-hero">
            <div className="biznesoty-hero__copy">
              <p className="biznesoty-hero__eyebrow">{APP_NAME}</p>
              <h1>Ваш бизнес — в порядке</h1>
              <p>Все инструменты в одном месте. Выбрал → подключил → настроил → работает.</p>
            </div>
            <div className="biznesoty-hero__tools desktop-only">
              <CommandSearch />
            </div>
          </header>

          {showIndustryNudge ? (
            <div className="panel panel--subtle" role="status">
              <p className="account-notice" role="status">
                Помогите {APP_NAME} лучше настроиться под ваш бизнес.{" "}
                <Link href="/onboarding">Выбрать направление</Link>
                {" · "}
                <Link href="/settings/advanced">Расширенная настройка</Link>
              </p>
            </div>
          ) : null}
          {setupSteps && !showIndustryNudge ? (
            <section className="dashboard-onboarding-card" role="status" aria-label="Прогресс настройки">
              <div className="dashboard-onboarding-card__header">
                <h2 className="dashboard-onboarding-card__title">
                  Стартовая настройка
                </h2>
                <span className="dashboard-onboarding-card__progress">
                  {setupSteps.done} из {setupSteps.total}
                </span>
              </div>
              <div className="onboarding-stepper" role="progressbar" aria-valuenow={setupSteps.done} aria-valuemin={0} aria-valuemax={setupSteps.total}>
                {setup?.steps.map((step) => (
                  <div
                    key={step.id}
                    className={`onboarding-stepper__item ${step.done ? "is-complete" : ""} ${!step.done && step === setup.next ? "is-current" : ""}`}
                  >
                    <div className="onboarding-stepper__dot">
                      {step.done ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      ) : (
                        <span aria-hidden>{step.id === "telegram" ? "📱" : step.id === "solutions" ? "🧩" : step.id === "industry" ? "🏢" : step.id === "ai" ? "🤖" : step.id === "catalog" ? "📦" : "○"}</span>
                      )}
                    </div>
                    <span className="onboarding-stepper__label">{step.label}</span>
                  </div>
                ))}
              </div>
              <p className="dashboard-onboarding-card__cta">
                {nextSetupHint ? `${nextSetupHint} ` : ""}
                <Link href={setup?.next?.href ?? "/onboarding"} className="text-link">
                  Продолжить →
                </Link>
              </p>
            </section>
          ) : null}
          {!isDemoMode &&
          data.businessId &&
          industryHint?.id === data.businessId &&
          !industryHint.onboardingDone ? (
            <SetupChecklist
              businessId={data.businessId}
              progress={industryHint.progress}
              industry={industryHint.industry}
              variant="compact"
              readiness={{
                hasIndustry: !!industryHint.industry,
                hasActiveSolution: data.workspaceItems.some(
                  (item) =>
                    item.status === "active" || item.status === "setup_required",
                ),
                hasConnection: !!industryHint.readiness.hasConnection,
              }}
            />
          ) : null}
          {recommendHint ? (
            <p className="account-notice" role="status">
              {recommendHint}
            </p>
          ) : null}

          {data.isLoading ? (
            <LoadingPanel label="Готовим рабочее пространство" />
          ) : (
            <>
              <QuickActions />
              <DashboardAiHint hint={nextSetupHint} />
              <section className="biznesoty-pulse" aria-labelledby="biznesoty-pulse-title">
                <div className="biznesoty-section-head">
                  <h2 id="biznesoty-pulse-title">Пульс бизнеса</h2>
                  <p>Ключевые показатели за период</p>
                </div>
                {data.businessId ? (
                  <DashboardKpis businessId={data.businessId} />
                ) : null}
              </section>
              <section className="biznesoty-solutions" aria-labelledby="biznesoty-solutions-title">
                <div className="biznesoty-section-head biznesoty-section-head--row">
                  <div>
                    <h2 id="biznesoty-solutions-title">Решения</h2>
                    <p>Инструменты, которые ведут клиентов</p>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    onClick={catalog}
                  >
                    Все решения
                  </button>
                </div>
                <SolutionCards items={data.workspaceItems} />
              </section>
              <div className="biznesoty-panels">
                {data.businessId ? (
                  <ActivityFeed businessId={data.businessId} />
                ) : null}
                {data.businessId ? (
                  <TodaySchedule businessId={data.businessId} />
                ) : null}
              </div>
              <aside className="biznesoty-hive desktop-only" aria-label="Живые соты">
                <div className="biznesoty-hive__glow" aria-hidden />
                <svg
                  className="biznesoty-hive__pattern"
                  viewBox="0 0 240 120"
                  aria-hidden
                >
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    opacity="0.35"
                  >
                    <path d="M40 20 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                    <path d="M76 40 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                    <path d="M112 20 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                    <path d="M148 40 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                    <path d="M184 20 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                    <path d="M112 60 l18 10 v20 l-18 10 l-18-10 v-20 z" />
                  </g>
                </svg>
                <div className="biznesoty-hive__copy">
                  <strong>Живые соты</strong>
                  <p>
                    Структура, рост и связь инструментов — ваш бизнес работает
                    как единая система.
                  </p>
                  <p className="biznesoty-hive__motto">
                    Выбрал → подключил → настроил → работает
                  </p>
                </div>
              </aside>
            </>
          )}
        </>
      )}

      {visibleSelection && (
        <DetailDialog title={dialogTitle} onClose={() => setSelection(null)}>
          {visibleSelection.type === "catalog" && (
            <>
              <p className="dialog-intro">
                Готовые инструменты для ваших ежедневных задач. Выберите то, что
                нужно вашему бизнесу.
              </p>
              {recommendHint && (
                <p className="account-notice" role="status">
                  {recommendHint} Подсказка, не ограничение.
                </p>
              )}
              <div className="catalog-grid">
                {data.workspaceItems.map((item) => (
                  <SolutionModule
                    key={item.solution.id}
                    item={item}
                    onSelect={selectSolution}
                    recommended={recommended.includes(item.code)}
                  />
                ))}
              </div>
            </>
          )}
          {visibleSelection.type === "solution" && (
            <>
              <div
                className={`solution-detail solution-detail--${visibleSelection.item.code}`}
              >
                <Image
                  src={visibleSelection.item.visual.assetSrc}
                  alt=""
                  width={1024}
                  height={1024}
                  sizes="180px"
                  unoptimized
                />
                <span
                  className={`solution-state tone-${solutionState(visibleSelection.item).tone}`}
                >
                  <i />
                  {solutionState(visibleSelection.item).label}
                </span>
              </div>
              <p className="dialog-intro">
                {visibleSelection.item.solution.description}
              </p>
              <div className="detail-facts">
                <span>Стоимость</span>
                <strong>
                  {formatSolutionPrice(
                    visibleSelection.item.solution.price,
                    productSolutionByCode(visibleSelection.item.code)
                      ?.messageLimit,
                  )}
                </strong>
              </div>
              {visibleSelection.item.note && (
                <p className="account-notice">{visibleSelection.item.note}</p>
              )}
              {activateError && (
                <p role="alert" className="account-error">
                  {activateError}
                </p>
              )}
              {visibleSelection.item.status === "available" && !isDemoMode ? (
                <button
                  type="button"
                  className="button button--primary button--full"
                  disabled={activating}
                  onClick={() =>
                    void connectSolution(visibleSelection.item.code)
                  }
                >
                  {activating ? "Подключаем…" : "Подключить"}
                  <ArrowUpRight size={18} />
                </button>
              ) : (
                <Link
                  className="button button--primary button--full"
                  href={productSolutionHref(
                    visibleSelection.item.status,
                    visibleSelection.item.code,
                  )}
                >
                  {productSolutionCta(
                    visibleSelection.item.status,
                    visibleSelection.item.code,
                    visibleSelection.item.entitlementStatus,
                  )}
                  <ArrowUpRight size={18} />
                </Link>
              )}
              {visibleSelection.item.status !== "available" && (
                <Link
                  className="button button--outline button--full"
                  href={solutionRoute(visibleSelection.item.code)}
                >
                  Открыть раздел
                  <ArrowUpRight size={18} />
                </Link>
              )}
            </>
          )}
          {visibleSelection.type === "lead" && (
            <>
              <div className="detail-facts">
                <span>Клиент</span>
                <strong>{visibleSelection.item.name}</strong>
              </div>
              <div className="detail-facts">
                <span>Площадка</span>
                <PlatformBadge platform={visibleSelection.item.source} />
              </div>
              <p className="message-preview">
                {visibleSelection.item.message ||
                  "Клиент не оставил сообщение."}
              </p>
              <p className="demo-note">
                {formatRelativeDateTime(visibleSelection.item.createdAt)}
              </p>
              <Link
                href="/leads"
                className="button button--outline button--full"
              >
                Все заявки
                <ArrowUpRight size={18} />
              </Link>
            </>
          )}
          {visibleSelection.type === "post" && (
            <>
              <h3 className="post-detail-title">{visibleSelection.item.text}</h3>
              <div className="detail-facts">
                <span>
                  {visibleSelection.item.publishAt
                    ? formatRelativeDateTime(visibleSelection.item.publishAt)
                    : "Дата не выбрана"}
                </span>
                <span className="post-row__platforms">
                  {visibleSelection.item.platforms.map((platform) => (
                    <PlatformBadge key={platform} platform={platform} compact />
                  ))}
                </span>
              </div>
            </>
          )}
        </DetailDialog>
      )}
    </div>
  );
}
