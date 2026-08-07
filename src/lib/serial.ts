export function extractSerial(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    const candidate = ['serial', 'serial_number', 'sn', 'product_serial', 'code']
      .map((key) => url.searchParams.get(key))
      .find(Boolean);
    if (candidate) return normaliseSerial(candidate);

    const tail = url.pathname.split('/').filter(Boolean).pop();
    if (tail && tail.length >= 4) return normaliseSerial(tail);
  } catch {
    // A serial is not necessarily a URL. The raw scan is still retained.
  }

  return normaliseSerial(trimmed);
}

export function normaliseSerial(value: string): string {
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

export function normaliseMobile(value: string): string {
  return value.replace(/\D/g, '').slice(-10);
}

export function isLikelyMobile(value: string): boolean {
  return normaliseMobile(value).length === 10;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function daysBetween(start: string, end = new Date().toISOString()): number {
  const milliseconds = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(0, Math.floor(milliseconds / 86_400_000));
}

export function addDays(date: Date, count: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next.toISOString();
}
