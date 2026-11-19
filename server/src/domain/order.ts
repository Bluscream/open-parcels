/**
 * Order numbers whose format a shop always uses. A number in another format cannot be that shop's,
 * which catches mails that merely mention the shop (paid with Amazon Pay, say) and were
 * attributed to it.
 */
const ORDER_NUMBER_FORMATS: Readonly<Record<string, RegExp>> = {
  // 123-1234567-1234567, and D01-1234567-1234567 for digital orders.
  amazon: /^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/,
};

/** False when the shop has a known order-number format and the number does not match it. */
export function isPlausibleOrder(shop: string, orderNumber: string): boolean {
  const format = ORDER_NUMBER_FORMATS[shop];
  return format === undefined || format.test(orderNumber.trim());
}

/** A shop named by its web address ("example-shop.de"), as labels and senders often are. */
export function shopFromDomain(value: string | null | undefined): string | null {
  const text =
    value
      ?.trim()
      .toLowerCase()
      .replace(/^www\./, "") ?? "";
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(text) ? text : null;
}
