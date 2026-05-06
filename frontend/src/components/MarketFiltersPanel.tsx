import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { useMarketFiltersTimeline } from '../api/hooks';
import { Badge, toneForValue } from './Badge';
import { Card } from './Card';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function MarketFiltersPanel({ symbol }: { symbol: string }) {
  const { data } = useMarketFiltersTimeline(symbol);
  const locale = useUiStore(state => state.locale);
  const latest = data?.timeline[data.timeline.length - 1];
  const chartData = data?.timeline.map(item => ({ ...item, time: formatDate(item.timestamp) })) || [];

  return (
    <Card title="Market Filters">
      {latest && (
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <FilterStat label="BTC.D" value={`${formatNumber(latest.btcDominanceValue, 2)}%`} meta={`${enumLabel(latest.btcDominanceTrend, locale)} / ${enumLabel(latest.btcDominanceSlope, locale)}`} impact={latest.btcDominanceImpact} locale={locale} />
          <FilterStat label="USDT.D" value={`${formatNumber(latest.usdtDominanceValue, 2)}%`} meta={`${enumLabel(latest.usdtDominanceTrend, locale)} / ${enumLabel(latest.usdtDominanceSlope, locale)}`} impact={latest.usdtDominanceImpact} locale={locale} />
          <FilterStat label="BTC trend" value={enumLabel(latest.btcTrend, locale)} meta={`4H ${enumLabel(latest.btcH4Trend, locale)}`} impact={latest.btcTrend} locale={locale} />
        </div>
      )}
      <div className="h-72">
        <ResponsiveContainer>
          <LineChart data={chartData}>
            <CartesianGrid stroke="rgba(148,163,184,0.14)" />
            <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
            <YAxis stroke="#64748b" fontSize={11} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <Line type="monotone" dataKey="btcDominanceValue" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="usdtDominanceValue" stroke="#38bdf8" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="price" stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function FilterStat({ label, value, meta, impact, locale }: { label: string; value: string; meta: string; impact: string; locale: 'ru' | 'en' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 font-display text-2xl font-bold">{value}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>{meta}</span>
        <Badge tone={toneForValue(impact)}>{enumLabel(impact, locale)}</Badge>
      </div>
    </div>
  );
}
