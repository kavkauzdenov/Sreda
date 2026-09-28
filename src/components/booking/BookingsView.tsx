"use client";
import { DetailDialog } from "@/components/dashboard/DetailDialog";
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSearchParams } from "next/navigation";
import { apiRequest } from "@/lib/apiClient";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { SolutionSetupBanner } from "@/components/solutions/SolutionSetupBanner";
import { Pagination } from "@/components/ui/Pagination";
import { Disclosure } from "@/components/ui/Disclosure";
import { AutoSchedulePanel } from "@/components/booking/AutoSchedulePanel";
import { BookingSetupWizard } from "@/components/booking/BookingSetupWizard";
import { FIELD_HINTS } from "@/lib/setupUx";
import { useBusinessTerminology } from "@/hooks/useBusinessTerminology";
import type { Terminology } from "@/lib/industryPresets";
type Service = {
  description: string;
  currency: string;
  id: string;
  name: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price: string | null;
  active: boolean;
};
type Specialist = {
  description: string;
  id: string;
  name: string;
  active: boolean;
};
type Catalog = {
  schedules: {
    specialist_id: string;
    weekday: number;
    intervals: { start: number; end: number }[];
  }[];
  exceptions: {
    specialist_id: string;
    date: string;
    reason: string;
    intervals: { start: number; end: number }[];
  }[];
  services: Service[];
  specialists: Specialist[];
  links: { service_id: string; specialist_id: string }[];
  manualSlots?: {
    id: string;
    specialist_id: string | null;
    service_id: string | null;
    starts_at: string;
    ends_at: string;
    capacity: number;
    active: boolean;
  }[];
  settings: {
    minimum_booking_notice: number;
    maximum_booking_horizon: number;
    slot_interval: number;
    choose_specialist?: boolean;
    schedule_mode?: "automatic" | "manual";
    allow_customer_cancel?: boolean;
    cancel_before_minutes?: number;
    allow_reschedule?: boolean;
    reschedule_before_minutes?: number;
  };
};
type Booking = {
  phone?: string;
  source?: string;
  id: string;
  client_name: string;
  service_name: string;
  specialist_name: string;
  service_id: string;
  specialist_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  revision: number;
};
const dateAt = (date: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const shiftIso = (iso: string, days: number) => {
  const [year = 1970, month = 1, day = 1] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const labelIso = (iso: string, style: "full" | "compact" = "full") => {
  const [year = 1970, month = 1, day = 1] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: style === "compact" ? "short" : "long",
    ...(style === "full" ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
};
const labels: Record<string, string> = {
  confirmed: "Подтверждена",
  pending: "Ожидает",
  completed: "Завершена",
  cancelled: "Отменена",
  no_show: "Не пришёл",
};
export function BookingsView() {
  const { currentBusiness } = useBusinessContext();
  const terms = useBusinessTerminology(currentBusiness?.id);
  return currentBusiness ? (
    <Calendar
      key={currentBusiness.id}
      businessId={currentBusiness.id}
      businessName={currentBusiness.name}
      timezone={currentBusiness.timezone ?? "UTC"}
      canConfigure={currentBusiness.role !== "operator"}
      terms={terms}
    />
  ) : (
    <p>Выберите бизнес.</p>
  );
}
function Calendar({
  businessId,
  businessName,
  timezone,
  canConfigure,
  terms,
}: {
  businessId: string;
  businessName: string;
  timezone: string;
  canConfigure: boolean;
  terms: Terminology;
}) {
  const base = `/api/v1/businesses/${businessId}`;
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [bookings, setBookings] = useState<Booking[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState("day"),
    [page, setPage] = useState(0),
    [date, setDate] = useState(dateAt(new Date(), timezone)),
    [service, setService] = useState(""),
    [specialist, setSpecialist] = useState(""),
    [slot, setSlot] = useState(""),
    [slots, setSlots] = useState<string[]>([]),
    [clients, setClients] = useState<{ id: string; name: string }[]>([]),
    [client, setClient] = useState(""),
    [clientSearch, setClientSearch] = useState(""),
    [clientName, setClientName] = useState(""),
    [clientPhone, setClientPhone] = useState(""),
    [reschedule, setReschedule] = useState<Booking | null>(null),
    [cancel, setCancel] = useState<Booking | null>(null),
    [selected, setSelected] = useState<Booking | null>(null),
    [deepLinked, setDeepLinked] = useState(false);
  const requestKey = useRef("");
  const configRef = useRef<HTMLElement | null>(null);
  const createPanelRef = useRef<HTMLElement | null>(null);
  const search = useSearchParams();
  const focusConfig = search.get("tab") === "config";
  const deepBookingId = search.get("booking") || "";
  const deepClientId = search.get("client") || "";
  const [solutionStatus, setSolutionStatus] = useState<string | null>(null);
  const [forceWizard, setForceWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [bannerLoading, setBannerLoading] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const range =
    mode === "list"
      ? ""
      : "&from=" +
        new Date(Date.parse(date) - 86400000).toISOString() +
        "&until=" +
        new Date(
          Date.parse(date) + (mode === "week" ? 8 : 2) * 86400000,
        ).toISOString();
  const bookingUrl = base + "/bookings?page=" + page + range;
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiRequest<Catalog>(base + "/booking-config"),
      apiRequest<Booking[]>(bookingUrl),
      apiRequest<{ id: string; name: string }[]>(base + "/clients"),
    ])
      .then(([c, b, cl]) => {
        if (alive) {
          setCatalog(c);
          setBookings(b);
          setClients(cl);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base, bookingUrl]);
  useEffect(() => {
    if (deepLinked) return;
    if (deepBookingId) {
      const found = bookings.find((b) => b.id === deepBookingId);
      if (found) {
        queueMicrotask(() => {
          setSelected(found);
          setDeepLinked(true);
        });
      }
      return;
    }
    if (deepClientId) {
      queueMicrotask(() => {
        setClient(deepClientId);
        setDeepLinked(true);
        requestAnimationFrame(() => {
          const target = createPanelRef.current ?? configRef.current;
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
          target
            ?.querySelector<HTMLElement>(
              "input, select, button, textarea",
            )
            ?.focus();
        });
      });
    }
  }, [bookings, deepBookingId, deepClientId, deepLinked]);
  useEffect(() => {
    if (!deepClientId) return;
    if (clients.some((c) => c.id === deepClientId)) return;
    let alive = true;
    void apiRequest<{
      client: { id: string; name: string };
    }>(
      `${base}/clients/${encodeURIComponent(deepClientId)}?view=v2`,
    )
      .then((data) => {
        if (!alive || !data.client) return;
        setClients((prev) =>
          prev.some((c) => c.id === data.client.id)
            ? prev
            : [...prev, { id: data.client.id, name: data.client.name }],
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, deepClientId, clients]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiRequest<{ solutionId: string; status: string }[]>(base + "/solutions"),
      apiRequest<{
        status: string;
        step?: number;
        draft?: { step?: number };
      } | null>(base + "/solutions?draft=booking"),
    ])
      .then(([solutions, draft]) => {
        if (!alive) return;
        const booking = solutions.find((s) => s.solutionId === "sol_booking");
        setSolutionStatus(booking?.status ?? null);
        const step =
          typeof draft?.draft?.step === "number"
            ? draft.draft.step
            : typeof draft?.step === "number"
              ? draft.step
              : 1;
        const inProgress =
          !!draft &&
          (draft.status === "in_progress" || draft.status === "reminded") &&
          step < 6;
        if (inProgress) {
          setForceWizard(true);
          setWizardStep(Math.max(1, Math.min(6, step)));
        }
        setDraftReady(true);
      })
      .catch(() => {
        if (alive) setDraftReady(true);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  useEffect(() => {
    if (!service || !specialist) return;
    let alive = true;
    void apiRequest<string[]>(
      base +
        `/booking-slots?service=${service}&specialist=${specialist}&date=${date}${reschedule ? "&exclude=" + reschedule.id : ""}`,
    )
      .then((s) => {
        if (alive) {
          setSlots(s);
          setSlot("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base, service, specialist, date, reschedule]);
  useEffect(() => {
    let alive = true;
    const timer = setInterval(
      () =>
        void apiRequest<Booking[]>(bookingUrl)
          .then((b) => {
            if (alive) setBookings(b);
          })
          .catch(() => {}),
      10000,
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, bookingUrl]);
  async function refresh() {
    setBookings(await apiRequest<Booking[]>(bookingUrl));
    setCatalog(await apiRequest<Catalog>(base + "/booking-config"));
  }
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void apiRequest<{ id: string; name: string }[]>(
        base + "/clients?search=" + encodeURIComponent(clientSearch),
      )
        .then((rows) => {
          if (alive) setClients(rows);
        })
        .catch((e) => {
          if (alive)
            setError(
              e instanceof Error ? e.message : "Не удалось найти клиента.",
            );
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base, clientSearch]);
  async function create() {
    setBusy(true);
    setError("");
    requestKey.current ||= crypto.randomUUID();
    try {
      if (reschedule)
        await apiRequest(base + "/bookings/" + reschedule.id, {
          method: "PATCH",
          body: JSON.stringify({
            action: "reschedule",
            revision: reschedule.revision,
            starts_at: slot,
          }),
        });
      else
        await apiRequest(base + "/bookings", {
          method: "POST",
          body: JSON.stringify({
            service_id: service,
            specialist_id: specialist,
            starts_at: slot,
            request_key: requestKey.current,
            ...(client
              ? { client_id: client }
              : { client: { name: clientName, phone: clientPhone } }),
          }),
        });
      requestKey.current = "";
      setReschedule(null);
      setSlot("");
      setNotice("Запись сохранена.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать запись.");
    } finally {
      setBusy(false);
    }
  }
  async function change(b: Booking, action: string) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(base + "/bookings/" + b.id, {
        method: "PATCH",
        body: JSON.stringify({ action, revision: b.revision }),
      });
      setCancel(null);
      await refresh();
      setNotice("Запись обновлена.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить запись.");
    } finally {
      setBusy(false);
    }
  }
  const fmt = (d: string) =>
    new Date(d).toLocaleString("ru", { timeZone: timezone });
  const until = new Date(Date.parse(date) + 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const visible = bookings.filter(
    (b) =>
      mode === "list" ||
      (dateAt(new Date(b.starts_at), timezone) >= date &&
        dateAt(new Date(b.starts_at), timezone) <=
          (mode === "week" ? until : date)),
  );
  const today = dateAt(new Date(), timezone);
  const servicesEmpty = !catalog || catalog.services.length === 0;
  const showSetupBanner =
    draftReady &&
    (forceWizard ||
      servicesEmpty ||
      solutionStatus === "setup_required");
  return (
    <div className="booking-page">
      <header className="page-header">
        <h1 className="text-page-title">Запись</h1>
        <p className="text-body-sm">Часовой пояс: {timezone}</p>
      </header>
      {showSetupBanner ? (
        <SolutionSetupBanner
          code="booking"
          loading={bannerLoading}
          onContinue={() => {
            setBannerLoading(true);
            setForceWizard(true);
            requestAnimationFrame(() => {
              configRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
              setBannerLoading(false);
            });
          }}
        />
      ) : null}
      <div className="booking-toolbar">
        <div className="booking-date-nav">
          <button
            type="button"
            className="button button--outline"
            onClick={() => {
              setDate(today);
              setSlots([]);
              setPage(0);
            }}
          >
            Сегодня
          </button>
          <button
            type="button"
            className="button button--outline"
            aria-label="Предыдущий день"
            onClick={() => {
              setDate(shiftIso(date, -1));
              setSlots([]);
              setPage(0);
            }}
          >
            ←
          </button>
          <strong className="booking-date-label">
            <span className="booking-date-label__full">{labelIso(date, "full")}</span>
            <span className="booking-date-label__compact">
              {labelIso(date, "compact")}
            </span>
          </strong>
          <button
            type="button"
            className="button button--outline"
            aria-label="Следующий день"
            onClick={() => {
              setDate(shiftIso(date, 1));
              setSlots([]);
              setPage(0);
            }}
          >
            →
          </button>
          <label className="booking-date-field">
            <span className="sr-only">Дата</span>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                setSlots([]);
                setPage(0);
                setSlot("");
                requestKey.current = "";
              }}
            />
          </label>
        </div>
        <div className="booking-modes" role="group" aria-label="Вид календаря">
          {(
            [
              ["day", "День"],
              ["week", "Неделя"],
              ["list", "Список"],
            ] as const
          ).map(([v, t]) => (
            <button
              key={v}
              type="button"
              className="button button--outline"
              aria-pressed={mode === v}
              onClick={() => {
                setMode(v);
                setPage(0);
              }}
            >
              {t}
            </button>
          ))}
        </div>
        {canConfigure ? (
          <a className="button button--ghost booking-settings-link" href="#booking-config">
            Настройки записи
          </a>
        ) : null}
      </div>
      {catalog && !catalog.services.length ? (
        <p className="account-footnote">
          Пройдите мастер настройки записи ниже — или откройте расширенные
          настройки.
        </p>
      ) : null}
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!catalog ? (
        <p>Загрузка…</p>
      ) : (
        <>
          <section className="panel crm-panel">
            {!visible.length ? (
              <p>На выбранную дату записей нет.</p>
            ) : (
              <div className="booking-resources">
                {catalog.specialists.map((r) => (
                  <section key={r.id}>
                    <h2>{r.name}</h2>
                    {visible
                      .filter((b) => b.specialist_id === r.id)
                      .map((b) => (
                        <article className="message-bubble" key={b.id}>
                          <strong>{fmt(b.starts_at)}</strong>
                          <p>
                            {b.client_name} · {b.service_name}
                          </p>
                          <p>{labels[b.status]}</p>
                          <button onClick={() => setSelected(b)}>
                            Открыть запись
                          </button>
                          {["pending", "confirmed"].includes(b.status) && (
                            <div className="message-actions">
                              <button
                                disabled={busy}
                                onClick={() => {
                                  setReschedule(b);
                                  setSlots([]);
                                  setService(b.service_id);
                                  setSpecialist(b.specialist_id);
                                  setSlot("");
                                }}
                              >
                                Перенести
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => setCancel(b)}
                              >
                                Отменить
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => void change(b, "complete")}
                              >
                                Завершить
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => void change(b, "no_show")}
                              >
                                Не пришёл
                              </button>
                            </div>
                          )}
                        </article>
                      ))}
                  </section>
                ))}
              </div>
            )}
            <Pagination
              page={page}
              hasNext={bookings.length >= 500}
              busy={busy}
              onPage={setPage}
            />
          </section>
          <section className="panel crm-panel" ref={createPanelRef}>
            <h2>{reschedule ? "Перенос записи" : "Создать запись"}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              {!reschedule && (
                <>
                  <label>
                    Найти клиента
                    <input
                      value={clientSearch}
                      placeholder="Имя, телефон или username"
                      onChange={(e) => {
                        setClientSearch(e.target.value);
                        setClient("");
                        requestKey.current = "";
                      }}
                    />
                  </label>
                  <label>
                    Клиент
                    <select
                      value={client}
                      onChange={(e) => {
                        setClient(e.target.value);
                        requestKey.current = "";
                      }}
                    >
                      <option value="">Новый клиент</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {client ? (
                    <p className="account-footnote">
                      Выбран:{" "}
                      <strong>
                        {clients.find((c) => c.id === client)?.name ??
                          "Клиент"}
                      </strong>
                    </p>
                  ) : null}
                  {!client && (
                    <>
                      <label>
                        Имя
                        <input
                          required
                          value={clientName}
                          onChange={(e) => {
                            setClientName(e.target.value);
                            requestKey.current = "";
                          }}
                        />
                      </label>
                      <label>
                        Телефон
                        <input
                          type="tel"
                          placeholder="+79991234567"
                          value={clientPhone}
                          onChange={(e) => {
                            setClientPhone(e.target.value);
                            requestKey.current = "";
                          }}
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              <label>
                Услуга
                <select
                  required
                  disabled={!!reschedule}
                  value={service}
                  onChange={(e) => {
                    setService(e.target.value);
                    setSpecialist("");
                    setSlots([]);
                    setSlot("");
                    requestKey.current = "";
                  }}
                >
                  <option value="">Выберите</option>
                  {catalog.services
                    .filter((s) => s.active)
                    .map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name} · {s.duration_minutes} мин
                        {s.price ? " · " + s.price + " " + s.currency : ""}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {terms.specialist}
                <select
                  required
                  disabled={!!reschedule}
                  value={specialist}
                  onChange={(e) => {
                    setSpecialist(e.target.value);
                    setSlots([]);
                    setSlot("");
                    requestKey.current = "";
                  }}
                >
                  <option value="">Выберите</option>
                  {catalog.specialists
                    .filter(
                      (r) =>
                        r.active &&
                        catalog.links.some(
                          (l) =>
                            l.specialist_id === r.id &&
                            l.service_id === service,
                        ),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
              <p>Дата записи: {date}. Измените её в календаре выше.</p>
              <label>
                Свободное время
                <select
                  required
                  value={slot}
                  onChange={(e) => {
                    setSlot(e.target.value);
                    requestKey.current = "";
                  }}
                >
                  <option value="">Выберите время</option>
                  {slots.map((s) => (
                    <option key={s} value={s}>
                      {fmt(s)}
                    </option>
                  ))}
                </select>
              </label>
              {specialist && !slots.length && (
                <p>На эту дату нет свободного времени.</p>
              )}
              <button
                className="button button--primary"
                disabled={busy || !slot}
              >
                Подтвердить
              </button>
              {reschedule && (
                <button type="button" onClick={() => setReschedule(null)}>
                  Отменить перенос
                </button>
              )}
            </form>
          </section>
          {canConfigure && (
            <Configuration
              base={base}
              businessId={businessId}
              businessName={businessName}
              timezone={timezone}
              catalog={catalog}
              onChange={refresh}
              openDetails={focusConfig}
              terms={terms}
              forceWizard={forceWizard}
              initialStep={wizardStep}
              sectionRef={configRef}
              onForceWizardChange={setForceWizard}
              onWizardStepChange={setWizardStep}
            />
          )}
        </>
      )}
      {cancel && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Отмена записи"
          className="panel crm-panel"
        >
          <p>
            Отменить запись {cancel.client_name} на {fmt(cancel.starts_at)}?
          </p>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => void change(cancel, "cancel")}
          >
            Да, отменить
          </button>
          <button
            className="button button--outline"
            onClick={() => setCancel(null)}
          >
            Назад
          </button>
        </div>
      )}
      {selected && (
        <DetailDialog title="Запись клиента" onClose={() => setSelected(null)}>
          <p>{selected.client_name}</p>
          <p>{selected.phone || "Телефон не указан"}</p>
          <p>
            {selected.service_name} · {selected.specialist_name}
          </p>
          <p>
            {fmt(selected.starts_at)} — {fmt(selected.ends_at)}
          </p>
          <p>
            {labels[selected.status]} · {selected.source}
          </p>
        </DetailDialog>
      )}
    </div>
  );
}
function Configuration({
  base,
  businessId,
  businessName,
  timezone,
  catalog,
  onChange,
  openDetails = false,
  terms,
  forceWizard = false,
  initialStep = 1,
  sectionRef,
  onForceWizardChange,
  onWizardStepChange,
}: {
  base: string;
  businessId: string;
  businessName: string;
  timezone: string;
  catalog: Catalog;
  onChange: () => Promise<void>;
  openDetails?: boolean;
  terms: Terminology;
  forceWizard?: boolean;
  initialStep?: number;
  sectionRef?: RefObject<HTMLElement | null>;
  onForceWizardChange?: (value: boolean) => void;
  onWizardStepChange?: (step: number) => void;
}) {
  const needsWizard = catalog.services.length === 0 || forceWizard;
  const [showAdvanced, setShowAdvanced] = useState(
    (!needsWizard && !forceWizard) || openDetails,
  );
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [service, setService] = useState({
      id: "",
      name: "",
      description: "",
      currency: "RUB",
      duration_minutes: 60,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      price: "",
      active: true,
    }),
    [specialist, setSpecialist] = useState({
      id: "",
      name: "",
      description: "",
      active: true,
    }),
    [resource, setResource] = useState(""),
    [weekday, setWeekday] = useState(1),
    [exception, setException] = useState(""),
    [reason, setReason] = useState(""),
    [hours, setHours] = useState("09:00-18:00"),
    [settings, setSettings] = useState({
      choose_specialist: true,
      schedule_mode: "automatic" as "automatic" | "manual",
      ...catalog.settings,
    }),
    [linked, setLinked] = useState<string[]>([]),
    [manualStart, setManualStart] = useState(""),
    [manualEnd, setManualEnd] = useState(""),
    [manualCapacity, setManualCapacity] = useState(1);
  async function save(body: unknown) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(base + "/booking-config", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await onChange();
      setNotice("Настройки сохранены.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
    } finally {
      setBusy(false);
    }
  }
  function showHours(resourceId: string, day: number) {
    const values =
      catalog.schedules.find(
        (s) => s.specialist_id === resourceId && s.weekday === day,
      )?.intervals ?? [];
    return values
      .map((v) =>
        [v.start, v.end]
          .map(
            (m) =>
              String(Math.floor(m / 60)).padStart(2, "0") +
              ":" +
              String(m % 60).padStart(2, "0"),
          )
          .join("-"),
      )
      .join(", ");
  }
  function ranges() {
    if (!hours.trim()) return [];
    return hours.split(",").map((part) => {
      const m = part.trim().match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
      if (!m) throw Error("Введите интервалы 09:00-12:00, 13:00-18:00.");
      return {
        start: Number(m[1]) * 60 + Number(m[2]),
        end: Number(m[3]) * 60 + Number(m[4]),
      };
    });
  }
  const advancedBlock = (
    <>
      <Disclosure title="Услуги" defaultOpen={openDetails && !needsWizard}>
        <select
          value={service.id}
          onChange={(e) => {
            const s = catalog.services.find((x) => x.id === e.target.value);
            setService(
              s
                ? { ...s, price: s.price ?? "" }
                : {
                    id: "",
                    name: "",
                    description: "",
                    currency: "RUB",
                    duration_minutes: 60,
                    buffer_before_minutes: 0,
                    buffer_after_minutes: 0,
                    price: "",
                    active: true,
                  },
            );
          }}
        >
          <option value="">Новая услуга</option>
          {catalog.services.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              ...service,
              id: service.id || undefined,
              kind: "service",
            });
          }}
        >
          <label>
            Название
            <input
              required
              value={service.name}
              onChange={(e) => setService({ ...service, name: e.target.value })}
            />
          </label>
          {(
            [
              "duration_minutes",
              "buffer_before_minutes",
              "buffer_after_minutes",
            ] as const
          ).map((k, i) => (
            <label key={k}>
              {
                [
                  "Длительность, мин",
                  "Подготовка до записи, мин",
                  "Перерыв между клиентами, мин",
                ][i]
              }
              <input
                type="number"
                min={k === "duration_minutes" ? 5 : 0}
                required
                value={service[k]}
                onChange={(e) =>
                  setService({ ...service, [k]: Number(e.target.value) })
                }
              />
              {k === "buffer_after_minutes" ? (
                <p className="field-hint">{FIELD_HINTS.bufferAfter}</p>
              ) : null}
            </label>
          ))}
          <label>
            Описание услуги
            <textarea
              value={service.description}
              onChange={(e) =>
                setService({ ...service, description: e.target.value })
              }
            />
          </label>
          <label>
            Валюта
            <input
              maxLength={3}
              value={service.currency}
              onChange={(e) =>
                setService({
                  ...service,
                  currency: e.target.value.toUpperCase(),
                })
              }
            />
          </label>
          <label>
            Цена
            <input
              type="number"
              min="0"
              step="0.01"
              value={service.price}
              onChange={(e) =>
                setService({ ...service, price: e.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={service.active}
              onChange={(e) =>
                setService({ ...service, active: e.target.checked })
              }
            />
            Услуга активна
          </label>
          <button disabled={busy}>Сохранить услугу</button>
        </form>
      </Disclosure>
      <Disclosure title={terms.specialists}>
        <select
          value={specialist.id}
          onChange={(e) =>
            setSpecialist(
              catalog.specialists.find((s) => s.id === e.target.value) ?? {
                id: "",
                name: "",
                description: "",
                active: true,
              },
            )
          }
        >
          <option value="">Новый {terms.specialist.toLowerCase()}</option>
          {catalog.specialists.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              ...specialist,
              id: specialist.id || undefined,
              kind: "specialist",
            });
          }}
        >
          <label>
            Имя
            <input
              required
              value={specialist.name}
              onChange={(e) =>
                setSpecialist({ ...specialist, name: e.target.value })
              }
            />
          </label>
          <label>
            Описание
            <textarea
              value={specialist.description}
              onChange={(e) =>
                setSpecialist({ ...specialist, description: e.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={specialist.active}
              onChange={(e) =>
                setSpecialist({ ...specialist, active: e.target.checked })
              }
            />
            {terms.specialist} активен
          </label>
          <button disabled={busy}>Сохранить</button>
        </form>
      </Disclosure>
      <Disclosure
        title={`Услуги и исключения (${terms.specialist.toLowerCase()})`}
      >
        <label>
          {terms.specialist}
          <select
            value={resource}
            onChange={(e) => {
              setResource(e.target.value);
              setHours(showHours(e.target.value, weekday));
              setLinked(
                catalog.links
                  .filter((l) => l.specialist_id === e.target.value)
                  .map((l) => l.service_id),
              );
            }}
          >
            <option value="">Выберите</option>
            {catalog.specialists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {catalog.services.map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              checked={linked.includes(s.id)}
              onChange={(e) =>
                setLinked(
                  e.target.checked
                    ? [...linked, s.id]
                    : linked.filter((x) => x !== s.id),
                )
              }
            />
            {s.name}
          </label>
        ))}
        <button
          disabled={busy || !resource}
          onClick={() =>
            void save({
              kind: "links",
              specialist_id: resource,
              service_ids: linked,
            })
          }
        >
          Сохранить услуги
        </button>
        <label>
          День недели
          <select
            value={weekday}
            onChange={(e) => {
              setWeekday(Number(e.target.value));
              setHours(showHours(resource, Number(e.target.value)));
            }}
          >
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((d, i) => (
              <option value={i} key={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Рабочие интервалы
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="09:00-12:00, 13:00-18:00"
          />
        </label>
        <p>
          Перерывы задаются между интервалами. Пустое поле означает выходной.
        </p>
        <button
          disabled={busy || !resource}
          onClick={() => {
            try {
              void save({
                kind: "schedule",
                specialist_id: resource,
                weekday,
                intervals: ranges(),
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Сохранить недельное расписание
        </button>
        <label>
          Исключение на дату
          <input
            type="date"
            value={exception}
            onChange={(e) => setException(e.target.value)}
          />
        </label>
        <ul>
          {catalog.exceptions
            .filter((x) => x.specialist_id === resource)
            .map((x) => (
              <li key={x.date}>
                {x.date} · {x.reason || "Особый график"} ·{" "}
                {x.intervals.length
                  ? x.intervals
                      .map((v) =>
                        [v.start, v.end]
                          .map(
                            (m) =>
                              String(Math.floor(m / 60)).padStart(2, "0") +
                              ":" +
                              String(m % 60).padStart(2, "0"),
                          )
                          .join("–"),
                      )
                      .join(", ")
                  : "Выходной"}
              </li>
            ))}
        </ul>
        <label>
          Причина
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button
          disabled={busy || !resource || !exception}
          onClick={() => {
            try {
              void save({
                kind: "exception",
                specialist_id: resource,
                date: exception,
                intervals: ranges(),
                reason,
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Применить интервалы только к этой дате
        </button>
      </Disclosure>
      <Disclosure title="Правила записи">
        {(
          [
            "minimum_booking_notice",
            "maximum_booking_horizon",
            "slot_interval",
          ] as const
        ).map((key, i) => (
          <label key={key}>
            {
              [
                "Минимальное время до записи, мин",
                "Горизонт записи, дней",
                "Шаг слотов, мин",
              ][i]
            }
            <input
              type="number"
              value={settings[key]}
              onChange={(e) =>
                setSettings({ ...settings, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={settings.choose_specialist !== false}
            onChange={(e) =>
              setSettings({
                ...settings,
                choose_specialist: e.target.checked,
              })
            }
          />{" "}
          Клиент выбирает: {terms.specialist.toLowerCase()}
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.allow_customer_cancel !== false}
            onChange={(e) =>
              setSettings({
                ...settings,
                allow_customer_cancel: e.target.checked,
              })
            }
          />{" "}
          Клиент может отменить запись
        </label>
        <label>
          Отмена не позднее чем за, мин
          <input
            type="number"
            min={0}
            value={settings.cancel_before_minutes ?? 0}
            onChange={(e) =>
              setSettings({
                ...settings,
                cancel_before_minutes: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.allow_reschedule !== false}
            onChange={(e) =>
              setSettings({
                ...settings,
                allow_reschedule: e.target.checked,
              })
            }
          />{" "}
          Клиент может перенести запись
        </label>
        <label>
          Перенос не позднее чем за, мин
          <input
            type="number"
            min={0}
            value={settings.reschedule_before_minutes ?? 0}
            onChange={(e) =>
              setSettings({
                ...settings,
                reschedule_before_minutes: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Режим расписания
          <select
            value={settings.schedule_mode ?? "automatic"}
            onChange={(e) =>
              setSettings({
                ...settings,
                schedule_mode: e.target.value as "automatic" | "manual",
              })
            }
          >
            <option value="automatic">Автоматическое расписание</option>
            <option value="manual">Ручные окна</option>
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() => void save({ kind: "settings", ...settings })}
        >
          Сохранить правила
        </button>
        {(settings.schedule_mode ?? "automatic") === "manual" && (
          <div>
            <h4>Ручные окна записи</h4>
            <label>
              Начало
              <input
                type="datetime-local"
                value={manualStart}
                onChange={(e) => setManualStart(e.target.value)}
              />
            </label>
            <label>
              Конец
              <input
                type="datetime-local"
                value={manualEnd}
                onChange={(e) => setManualEnd(e.target.value)}
              />
            </label>
            <label>
              Вместимость
              <input
                type="number"
                min={1}
                max={100}
                value={manualCapacity}
                onChange={(e) => setManualCapacity(Number(e.target.value))}
              />
            </label>
            <button
              disabled={busy || !manualStart || !manualEnd}
              onClick={() =>
                void save({
                  kind: "manual_slot",
                  starts_at: new Date(manualStart).toISOString(),
                  ends_at: new Date(manualEnd).toISOString(),
                  capacity: manualCapacity,
                  specialist_id: resource || null,
                }).then(() => {
                  setManualStart("");
                  setManualEnd("");
                })
              }
            >
              Добавить окно
            </button>
            <ul>
              {(catalog.manualSlots ?? []).map((slot) => (
                <li key={slot.id}>
                  {new Date(slot.starts_at).toLocaleString("ru")} —{" "}
                  {new Date(slot.ends_at).toLocaleString("ru")} · до{" "}
                  {slot.capacity}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void save({ kind: "manual_slot_delete", id: slot.id })
                    }
                  >
                    Удалить
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Disclosure>
    </>
  );

  return (
    <section
      className="panel crm-panel"
      id="booking-config"
      ref={sectionRef as RefObject<HTMLElement>}
    >
      <h2>Настройка записи</h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!needsWizard ? (
        <div className="booking-config-actions">
          <button
            type="button"
            className="button button--outline button--sm"
            disabled={busy}
            onClick={() => setShowAdvanced(true)}
          >
            Изменить настройки
          </button>
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Настроить запись заново? Клиенты и история записей не удалятся. Услуги, специалисты и расписание будут сброшены.",
                )
              )
                return;
              void (async () => {
                setBusy(true);
                setError("");
                try {
                  await apiRequest(base + "/booking-config", {
                    method: "POST",
                    body: JSON.stringify({ kind: "reset_setup" }),
                  });
                  onForceWizardChange?.(true);
                  onWizardStepChange?.(1);
                  setShowAdvanced(false);
                  setNotice("Настройка сброшена. Пройдите мастер заново.");
                  await onChange();
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Не удалось сбросить настройку.",
                  );
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Настроить заново
          </button>
        </div>
      ) : null}
      {needsWizard ? (
        <BookingSetupWizard
          key={`wizard-${initialStep}-${forceWizard}`}
          businessId={businessId}
          businessName={businessName}
          timezone={timezone}
          catalog={catalog}
          initialStep={initialStep}
          onStepSaved={async (step) => {
            onWizardStepChange?.(step);
            try {
              await apiRequest(`/api/v1/businesses/${businessId}/solutions`, {
                method: "POST",
                body: JSON.stringify({
                  action: "touch_draft",
                  code: "booking",
                  draft: { step },
                }),
              });
            } catch {
              /* non-blocking draft persistence */
            }
          }}
          onComplete={async () => {
            try {
              await apiRequest(`/api/v1/businesses/${businessId}/solutions`, {
                method: "POST",
                body: JSON.stringify({
                  action: "complete_draft",
                  code: "booking",
                }),
              });
            } catch {
              /* ignore */
            }
            onForceWizardChange?.(false);
            await onChange();
            setShowAdvanced(true);
          }}
          onSkipToAdvanced={() => setShowAdvanced(true)}
        />
      ) : null}
      {!needsWizard || showAdvanced ? (
        <div className="booking-config-primary">
          {!needsWizard ? (
            <p className="account-footnote">
              Основной путь —{" "}
              <strong>Автоматическое расписание</strong>: рабочие дни и часы,
              остальное БизнеСоты рассчитают сами.
            </p>
          ) : null}
          <AutoSchedulePanel
            businessId={businessId}
            timezone={timezone}
            specialists={catalog.specialists.map((s) => ({
              id: s.id,
              name: s.name,
            }))}
            services={catalog.services.map((s) => ({
              id: s.id,
              name: s.name,
              duration_minutes: s.duration_minutes,
            }))}
            schedules={catalog.schedules}
            settings={catalog.settings}
            onSaved={onChange}
          />
          <Disclosure
            title="Расширенные настройки"
            hint="Услуги, специалисты, исключения и правила вручную"
            defaultOpen={openDetails && !needsWizard}
          >
            {advancedBlock}
          </Disclosure>
        </div>
      ) : (
        <div className="booking-config-advanced-toggle">
          <button
            type="button"
            className="button button--outline"
            onClick={() => setShowAdvanced(true)}
          >
            Расширенные настройки
          </button>
        </div>
      )}
    </section>
  );
}
