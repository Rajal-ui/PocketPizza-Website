import type { OrderWhatsappState } from '@pokket-pizza/contract/contract';
import { env } from '../../config/env';
import { getPrisma } from '../../config/database';
import { createChildLogger } from '../../utils/logger';
import {
  NOTIFICATION_CHANNEL_WHATSAPP,
  createAttempt,
  findAttempt,
} from './notification.repository';
import type { DispatchOrderInput, WhatsAppSendResult } from './notification.types';
import { sendCustomerConfirmation, isBspConfigured } from './bsp.provider';

const logger = createChildLogger({ module: 'notifications' });

/** Approved BSP template name, logged to Notification.template for correlation. */
export const CUSTOMER_CONFIRMATION_TEMPLATE = env.CUSTOMER_TEMPLATE_NAME || 'order_confirmation';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry with exponential backoff (250ms, 500ms). Only retryable
 * failures (network / 429 / 5xx) are retried; a 4xx (bad key, unapproved
 * template, invalid number) fails immediately — retrying it just burns quota.
 */
async function withRetry(op: () => Promise<WhatsAppSendResult>): Promise<WhatsAppSendResult> {
  let last: WhatsAppSendResult = { success: false, error: 'not attempted', retryable: false };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    try {
      last = await op();
    } catch (err) {
      last = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
    if (last.success || !last.retryable) return last;
  }
  return last;
}

type AttemptLog = {
  template: string;
  destination: string;
  status: 'sent' | 'failed' | 'skipped';
  providerMessageId?: string | null;
  errorMessage?: string | null;
};

/** The Notification write must never propagate into the dispatch flow. */
async function logAttempt(orderId: string, attempt: AttemptLog): Promise<void> {
  try {
    await createAttempt({
      orderId,
      channel: NOTIFICATION_CHANNEL_WHATSAPP,
      template: attempt.template,
      destination: attempt.destination,
      status: attempt.status,
      providerMessageId: attempt.providerMessageId ?? null,
      errorMessage: attempt.errorMessage ?? null,
    });
    logger.info(
      {
        orderId,
        template: attempt.template,
        status: attempt.status,
        providerMessageId: attempt.providerMessageId,
        destinationTail: attempt.destination.slice(-4),
      },
      'whatsapp attempt logged',
    );
  } catch (err) {
    logger.error({ err, orderId, template: attempt.template }, 'failed to log notification attempt');
  }
}

async function sendAndLog(
  orderId: string,
  template: string,
  destination: string,
  op: () => Promise<WhatsAppSendResult>,
): Promise<void> {
  // Idempotency: one logged attempt per (order, template) — a retried or
  // replayed dispatch must not double-message the customer.
  const existing = await findAttempt(orderId, template);
  if (existing) {
    logger.info({ orderId, template }, 'attempt already logged, skipping re-send');
    return;
  }

  const result = await withRetry(op);
  await logAttempt(orderId, {
    template,
    destination,
    status: result.success ? 'sent' : 'failed',
    providerMessageId: result.messageId ?? null,
    errorMessage: result.error ? result.error.slice(0, 500) : null,
  });
  if (!result.success) {
    logger.warn({ orderId, template, error: result.error }, 'whatsapp send failed (order unaffected)');
  }
}

async function runDispatch(input: DispatchOrderInput): Promise<void> {
  const prisma = await getPrisma();

  const customer = await prisma.customer.findUnique({
    where: { phone: input.customerPhone },
    select: { name: true, whatsappOrderUpdates: true },
  });

  // Customer confirmation — honour the whatsappOrderUpdates opt-out.
  const optedIn = customer?.whatsappOrderUpdates ?? true;
  const customerDestination = input.customerPhone;
  if (!optedIn) {
    const existing = await findAttempt(input.orderId, CUSTOMER_CONFIRMATION_TEMPLATE);
    if (!existing) {
      await logAttempt(input.orderId, {
        template: CUSTOMER_CONFIRMATION_TEMPLATE,
        destination: customerDestination,
        status: 'skipped',
        errorMessage: 'customer disabled whatsapp order updates',
      });
    }
    return;
  }

  const customerName = customer?.name ?? 'there';
  await sendAndLog(
    input.orderId,
    CUSTOMER_CONFIRMATION_TEMPLATE,
    customerDestination,
    () =>
      sendCustomerConfirmation(
        customerDestination,
        customerName,
        input.orderNumber,
        input.total,
      ),
  );
}

/**
 * Fire-and-forget dispatch, called ONLY after the order transaction commits.
 *
 * - never awaited by the order flow: the customer response does not wait on
 *   the BSP, and a slow or dead provider cannot hold the request open;
 * - never throws into the caller: every failure is contained here and, where
 *   it matters, recorded in the Notification table;
 * - a failed WhatsApp send never rolls back, blocks or invalidates the order.
 */
export function dispatchOrderNotifications(input: DispatchOrderInput): void {
  void (async () => {
    try {
      await runDispatch(input);
    } catch (err) {
      logger.error({ err, orderId: input.orderId }, 'whatsapp dispatch crashed (order unaffected)');
    }
  })();
}

/** DB status → public contract status. Provider delivery states (queued/
 *  sending/delivered/read) collapse to sent/pending so the UI stays simple. */
export function mapNotificationStatusToPublic(status: string): OrderWhatsappState['status'] {
  switch (status) {
    case 'failed':
    case 'undelivered':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'sent':
    case 'delivered':
    case 'read':
      return 'sent';
    default:
      return 'pending';
  }
}

/** "+91 •••••• 3210" — the raw number never crosses the API boundary. */
export function maskDestination(destination: string): string | null {
  const digits = (destination ?? '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  return `+91 \u2022\u2022\u2022\u2022\u2022\u2022 ${last4}`;
}

/** Boot-time visibility for the Day 9 checklist (no secrets logged). */
export function logDispatchConfig(): void {
  logger.info(
    {
      bspConfigured: isBspConfigured(),
      customerTemplateConfigured: Boolean(env.CUSTOMER_TEMPLATE_NAME),
    },
    'notification dispatch config',
  );
}
