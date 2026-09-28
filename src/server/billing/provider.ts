import { AppError } from "../http/errors.ts";
import type {
  BillingProviderName,
  CheckoutInput,
  CheckoutSession,
  WebhookResult,
} from "./types.ts";

/**
 * Payment provider boundary. Real YooKassa/Stripe adapters are intentionally
 * not implemented until explicitly confirmed.
 */
export interface BillingProvider {
  readonly name: BillingProviderName;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  handleWebhook(rawBody: string, headers: Headers): Promise<WebhookResult>;
}

/** Production default: honest refusal — no fake payment success. */
export class NoopBillingProvider implements BillingProvider {
  readonly name = "noop" as const;

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    void input;
    throw new AppError(
      501,
      "BILLING_NOT_CONFIGURED",
      "Подключение оплаты ещё не настроено.",
    );
  }

  async handleWebhook(
    rawBody: string,
    headers: Headers,
  ): Promise<WebhookResult> {
    void rawBody;
    void headers;
    return { handled: false, reason: "noop_provider" };
  }
}

/**
 * Test-only provider. Construction throws outside test/development.
 * Never wire into production runtime or UI success paths.
 */
export class MockBillingProvider implements BillingProvider {
  readonly name = "mock" as const;
  private readonly checkouts: CheckoutSession[] = [];
  private webhookHandler:
    | ((rawBody: string, headers: Headers) => Promise<WebhookResult>)
    | null = null;

  constructor() {
    const env = process.env.NODE_ENV;
    if (env === "production") {
      throw new Error(
        "MockBillingProvider is test-only and must not be used in production",
      );
    }
  }

  onWebhook(
    handler: (rawBody: string, headers: Headers) => Promise<WebhookResult>,
  ) {
    this.webhookHandler = handler;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const session: CheckoutSession = {
      id: `mock_cs_${this.checkouts.length + 1}`,
      url: `${input.successUrl}?mock_checkout=1`,
      provider: "mock",
    };
    this.checkouts.push(session);
    return session;
  }

  /** Exposed for assertions in tests only. */
  listCheckouts(): readonly CheckoutSession[] {
    return this.checkouts;
  }

  async handleWebhook(
    rawBody: string,
    headers: Headers,
  ): Promise<WebhookResult> {
    if (this.webhookHandler) return this.webhookHandler(rawBody, headers);
    return { handled: false, reason: "mock_no_handler" };
  }
}

let defaultProvider: BillingProvider = new NoopBillingProvider();

export function getBillingProvider(): BillingProvider {
  return defaultProvider;
}

/** Dependency injection for tests; production keeps NoopBillingProvider. */
export function setBillingProviderForTests(provider: BillingProvider): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Cannot replace billing provider in production");
  }
  defaultProvider = provider;
}

export function resetBillingProvider(): void {
  defaultProvider = new NoopBillingProvider();
}
