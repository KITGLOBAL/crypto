import { classNames } from '../utils/format';

const variants = {
  green: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  red: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  blue: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  gray: 'border-slate-500/30 bg-slate-500/10 text-slate-200'
};

export function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: keyof typeof variants }) {
  return (
    <span className={classNames('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold', variants[tone])}>
      {children}
    </span>
  );
}

export function toneForValue(value?: string): keyof typeof variants {
  if (!value) return 'gray';
  if (['LONG', 'BULLISH', 'CONFIRMED', 'IN_ZONE', 'GOOD', 'WATCHING'].includes(value)) return 'green';
  if (['SHORT', 'BEARISH', 'INVALIDATED', 'EXPIRED'].includes(value)) return 'red';
  if (['WAIT', 'WATCH', 'CHASE', 'MISSED', 'INVALID_BY_RR', 'CONFIRMATION_PENDING'].includes(value)) return 'amber';
  if (['DISABLED', 'NEUTRAL', 'NONE', 'POOR'].includes(value)) return 'gray';
  return 'blue';
}
