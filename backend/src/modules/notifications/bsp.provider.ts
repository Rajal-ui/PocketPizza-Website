import { env } from '../../config/env';
import type { WhatsAppSendResult } from './notification.types';

const SEND_TIMEOUT_MS = 8_000;
const MAX_ERROR_LENGTH = 300;
const TEMPLATE_LANGUAGE = 'en';

/**
 * E.164 (+919876543210) for WhatsApp. Accepts the shapes we already tolerate
 * elsewhere: bare 10-digit, 0-prefixed, 91-prefixed, +91-prefixed.
 * Throws on anything that is not a plausible phone number.
 */
export function formatE164(raw: string): string {
  let s = (raw ?? '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`;
  if (/^91[6-9]\d{9}$/.test(s)) return `+${s}`;
  if (/^0[6-9]\d{9}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^\d{7,15}$/.test(s)) return `+${s}`;
  throw new Error(`cannot format "${raw}" as E.164`);
}

/** true when every BSP credential the send needs is present. */
export function isBspConfigured(): boolean {
  return Boolean(
    env.BSP_API_KEY &&
      env.BSP_API_ENDPOINT &&
      env.BSP_WHATSAPP_NUMBER &&
      env.CUSTOMER_TEMPLATE_NAME,
  );
}

type BspLikeError = { message?: string; error?: { message?: string } };

function classifyError(status: number | undefined, err: unknown, label: string): WhatsAppSendResult {
  const e = (typeof err === 'object' && err !== null ? err : {}) as BspLikeError;
  // No HTTP status → transport-level failure (DNS/timeout/refused): transient.
  const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  const detail = [
    label,
    status !== undefined ? `HTTP ${status}` : 'network error',
    e.error?.message ?? e.message ?? 'send failed',
  ]
    .filter(Boolean)
    .join(' ');
  return { success: false, error: detail.slice(0, MAX_ERROR_LENGTH), retryable };
}

/**
 * Customer order confirmation — approved BSP template `CUSTOMER_TEMPLATE_NAME`.
 * Variable numbering must match the approved template:
 *   {{1}} = customer name, {{2}} = order number, {{3}} = total amount.
 *
 * YCloud implements the WhatsApp Business Platform on top of the standard
 * Cloud API payload; authentication uses the `X-API-Key` header and the sender
 * is identified by `from` in E.164.
 */
export async function sendCustomerConfirmation(
  customerPhone: string,
  name: string,
  orderNumber: string,
  totalAmount: string,
): Promise<WhatsAppSendResult> {
  if (!isBspConfigured()) {
    return {
      success: false,
      error: 'customer_confirmation: BSP credentials not configured',
      retryable: false,
    };
  }

  let from: string;
  let to: string;
  try {
    from = formatE164(env.BSP_WHATSAPP_NUMBER);
    to = formatE164(customerPhone);
  } catch (err) {
    return {
      success: false,
      error: `customer_confirmation: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        MAX_ERROR_LENGTH,
      ),
      retryable: false,
    };
  }

  let payload: {
    id?: string;
    messageId?: string;
    message?: string;
    error?: { message?: string };
  } = {};

  let status: number | undefined;
  try {
    const response = await fetch(env.BSP_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.BSP_API_KEY,
      },
      body: JSON.stringify({
        from,
        to,
        type: 'template',
        template: {
          name: env.CUSTOMER_TEMPLATE_NAME,
          language: { code: TEMPLATE_LANGUAGE },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: name },
                { type: 'text', text: orderNumber },
                { type: 'text', text: totalAmount },
              ],
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    status = response.status;

    payload = (await response.json().catch(() => ({}))) as typeof payload;

    if (!response.ok) {
      return classifyError(status, payload, 'customer_confirmation');
    }

    const messageId = payload.id ?? payload.messageId;
    if (!messageId) {
      return {
        success: false,
        error: 'customer_confirmation: empty response from BSP',
        retryable: false,
      };
    }

    return { success: true, messageId, retryable: false };
  } catch (err) {
    return classifyError(status, err, 'customer_confirmation');
  }
}
