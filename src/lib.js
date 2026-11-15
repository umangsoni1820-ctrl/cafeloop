export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (options.raw && response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof data === 'object' ? data.error || 'Something went wrong.' : data || 'Something went wrong.');
  return data;
}

export const customerStorageKey = (slug) => `cafeloop:${slug}:customer`;
export function readCustomer(slug) {
  try { return JSON.parse(localStorage.getItem(customerStorageKey(slug)) || 'null'); }
  catch { return null; }
}
export function saveCustomer(slug, customer) {
  localStorage.setItem(customerStorageKey(slug), JSON.stringify(customer));
}
export function money(amount, currency = 'INR', locale) {
  const resolvedLocale = locale || (currency === 'INR' ? 'en-IN' : undefined);
  return new Intl.NumberFormat(resolvedLocale, {
    style: 'currency', currency, maximumFractionDigits: 2,
    ...(currency === 'INR' ? { minimumFractionDigits: 0 } : {}),
  }).format(Number(amount || 0));
}
export function timeAgo(date) {
  if (!date) return 'No visits yet';
  const hours = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 3600000));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
export function dateLabel(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date));
}
export function initials(value = '') {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'C';
}
