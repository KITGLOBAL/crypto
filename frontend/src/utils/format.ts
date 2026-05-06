export function formatNumber(value?: number | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(digits)}K`;
  return value.toFixed(digits);
}

export function formatPct(value?: number | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)}%`;
}

export function formatDate(value?: string): string {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function classNames(...items: Array<string | false | undefined>): string {
  return items.filter(Boolean).join(' ');
}
