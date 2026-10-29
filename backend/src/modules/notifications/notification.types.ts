export type WhatsAppSendResult = {
  success: boolean;
  /** BSP message id on success — used for delivery-status correlation. */
  messageId?: string;
  error?: string;
  /** Network failures, 429 and 5xx are transient → worth a bounded retry. */
  retryable: boolean;
};

export type DispatchOrderInput = {
  orderId: string;
  orderNumber: string;
  /** 10-digit Indian mobile from normalizeIndianPhone. */
  customerPhone: string;
  /** @decimal "828.00" */
  total: string;
};
