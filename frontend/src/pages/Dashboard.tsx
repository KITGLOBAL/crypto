import { Link } from 'react-router-dom';
import { Fragment, useMemo, useState } from 'react';
import { useAnalysisList, useMarketOverview } from '../api/hooks';
import { EmptyState, ErrorState } from '../components/AsyncState';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { useUiStore } from '../store/uiStore';
import type { DashboardAnalysisItem } from '../types/analysis';
import { formatDate, formatNumber, formatPct } from '../utils/format';
import { enumLabel, pairLabel } from '../utils/i18n';

export function Dashboard() {
  const { data = [], isLoading, error } = useAnalysisList();
  const { data: market, error: marketError } = useMarketOverview();
  const filters = useUiStore(state => state.filters);
  const sorting = useUiStore(state => state.sorting);
  const setFilter = useUiStore(state => state.setFilter);
  const setSorting = useUiStore(state => state.setSorting);
  const locale = useUiStore(state => state.locale);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    return data
      .filter(row => filters.decision === 'ALL' || row.mainDecision === filters.decision)
      .filter(row => filters.actionableStatus === 'ALL' || row.actionableStatus === filters.actionableStatus)
      .filter(row => filters.tacticalStatus === 'ALL' || row.tacticalStatus === filters.tacticalStatus)
      .sort((a, b) => sortRows(a, b, sorting.key, sorting.direction));
  }, [data, filters, sorting]);

  return (
    <div className="space-y-5">
      {(error || marketError) && <ErrorState error={error || marketError} />}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <div className="text-sm text-slate-400">BTC Dominance</div>
          <div className="mt-2 font-display text-3xl font-bold">{market?.btcDominance ? formatPct(market.btcDominance.value) : 'n/a'}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-400">USDT Dominance</div>
          <div className="mt-2 font-display text-3xl font-bold">{market?.usdtDominance ? formatPct(market.usdtDominance.value) : 'n/a'}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-400">Total Market Cap</div>
          <div className="mt-2 font-display text-3xl font-bold">{formatNumber(market?.totalMarketCapUsd?.value, 2)}</div>
        </Card>
      </div>

      <Card title="Watchlist Heatmap">
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:hidden">
          {rows.map(row => (
            <Link key={row.symbol} to={`/symbols/${row.symbol}`} className="rounded-3xl border border-white/10 bg-white/[0.045] p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-display text-xl font-bold">{row.symbol}</span>
                <Badge tone={toneForValue(row.mainDecision)}>{enumLabel(row.mainDecision, locale)}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <MiniMetric label="Bias" value={`${enumLabel(row.bias, locale)} ${row.directionScore}`} />
                <MiniMetric label="Actionable" value={enumLabel(row.actionableStatus, locale)} />
                <MiniMetric label="Tactical" value={pairLabel(row.tacticalStatus, row.tacticalSide, locale)} />
                <MiniMetric label="R/R" value={formatNumber(row.riskReward, 2)} />
              </div>
            </Link>
          ))}
        </div>
        <div className="mb-4 flex flex-wrap gap-3">
          <select className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm" value={filters.decision} onChange={e => setFilter('decision', e.target.value as any)}>
            {['ALL', 'LONG', 'SHORT', 'WAIT'].map(value => <option key={value} value={value}>{enumLabel(value, locale)}</option>)}
          </select>
          <select className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm" value={filters.actionableStatus} onChange={e => setFilter('actionableStatus', e.target.value as any)}>
            {['ALL', 'WATCHING', 'IN_ZONE', 'MISSED', 'INVALID_BY_RR', 'INVALIDATED', 'EXPIRED'].map(value => <option key={value} value={value}>{enumLabel(value, locale)}</option>)}
          </select>
          <select className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm" value={filters.tacticalStatus} onChange={e => setFilter('tacticalStatus', e.target.value as any)}>
            {['ALL', 'DISABLED', 'WATCH', 'IN_ZONE', 'CONFIRMATION_PENDING', 'CONFIRMED', 'INVALIDATED'].map(value => <option key={value} value={value}>{enumLabel(value, locale)}</option>)}
          </select>
        </div>

        <div className="hidden overflow-x-auto lg:block">
          {!isLoading && rows.length === 0 && (
            <EmptyState title="No snapshots yet" description="Dashboard uses stored analysis snapshots. Wait for the snapshot worker or run /analyze for symbols." />
          )}
          <table className="w-full min-w-[1180px] border-separate border-spacing-y-2 text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.2em] text-slate-500">
              <tr>
                {['symbol', 'price', 'main', 'bias', 'setup', 'risk', 'actionable', 'tradable', 'tactical', 'R/R', 'volume', 'CVD', 'funding rank', 'OI 24h/7d', 'updated'].map(header => (
                  <th key={header} className="px-3 py-2">
                    <button onClick={() => setSorting(headerToSortKey(header))}>{header}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td className="px-3 py-8 text-slate-400" colSpan={15}>Loading snapshots...</td></tr>}
              {rows.map(row => (
                <Fragment key={row.symbol}>
                  <tr className="bg-white/[0.035] transition hover:bg-white/[0.07]">
                    <td className="rounded-l-2xl px-3 py-3 font-display font-bold text-white">
                      <button className="mr-2 text-slate-400 hover:text-white" onClick={() => setExpanded(expanded === row.symbol ? null : row.symbol)}>
                        {expanded === row.symbol ? '−' : '+'}
                      </button>
                      <Link to={`/symbols/${row.symbol}`}>{row.symbol}</Link>
                    </td>
                    <td className="px-3 py-3">{formatNumber(row.price, row.price > 100 ? 1 : 4)}</td>
                    <td className="px-3 py-3"><Badge tone={toneForValue(row.mainDecision)}>{enumLabel(row.mainDecision, locale)}</Badge></td>
                    <td className="px-3 py-3"><ScorePill value={row.directionScore} /></td>
                    <td className="px-3 py-3"><Badge tone={toneForValue(row.setupQuality)}>{enumLabel(row.setupQuality, locale)} {row.setupQualityScore}</Badge></td>
                    <td className="px-3 py-3"><ScorePill value={row.riskScore} /></td>
                    <td className="px-3 py-3"><Badge tone={toneForValue(row.actionableStatus)}>{enumLabel(row.actionableStatus, locale)}</Badge></td>
                    <td className="px-3 py-3">{row.actionableTradable ? <Badge tone="green">{enumLabel('YES', locale)}</Badge> : <Badge tone="gray">{enumLabel('NO', locale)}</Badge>}</td>
                    <td className="px-3 py-3"><Badge tone={toneForValue(row.tacticalStatus)}>{pairLabel(row.tacticalStatus, row.tacticalSide, locale)}</Badge></td>
                    <td className="px-3 py-3">{formatNumber(row.riskReward, 2)}</td>
                    <td className="px-3 py-3">{formatNumber(row.volumeRatio, 2)}x</td>
                    <td className="px-3 py-3"><Badge tone={toneForValue(row.cvdTrend)}>{enumLabel(row.cvdTrend, locale)}</Badge></td>
                    <td className="px-3 py-3">{row.fundingPercentile30d}/100</td>
                    <td className="px-3 py-3">{formatPct(row.oiChange24h)} / {formatPct(row.oiChange7d)}</td>
                    <td className="rounded-r-2xl px-3 py-3 text-slate-400">{formatDate(row.updatedAt)}</td>
                  </tr>
                  {expanded === row.symbol && (
                    <tr>
                      <td colSpan={15} className="rounded-2xl bg-black/20 p-4">
                        <ExpandedRow row={row} locale={locale} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ExpandedRow({ row, locale }: { row: DashboardAnalysisItem; locale: 'ru' | 'en' }) {
  return (
    <div className="grid gap-3 text-sm md:grid-cols-5">
      <MiniMetric label="CVD" value={`${enumLabel(row.cvdTrend, locale)}, delta ${formatNumber(row.deltaRatio, 2)}x`} />
      <MiniMetric label="Funding" value={`${formatNumber(row.fundingRate * 100, 4)}%, rank ${row.fundingPercentile30d}/100`} />
      <MiniMetric label="OI 24h / 7d" value={`${formatPct(row.oiChange24h)} / ${formatPct(row.oiChange7d)}`} />
      <MiniMetric label="Actionable setup" value={row.actionableSetupId || 'n/a'} />
      <MiniMetric label="Tactical R/R" value={formatNumber(row.tacticalRR, 2)} />
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
      <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-1 break-all font-semibold text-white">{value}</div>
    </div>
  );
}

function ScorePill({ value }: { value: number }) {
  const tone = value >= 65 ? 'green' : value <= -65 ? 'red' : Math.abs(value) >= 40 ? 'amber' : 'gray';
  return <Badge tone={tone}>{value}/100</Badge>;
}

function sortRows(a: DashboardAnalysisItem, b: DashboardAnalysisItem, key: string, direction: 'asc' | 'desc') {
  const left = a[key as keyof DashboardAnalysisItem] ?? 0;
  const right = b[key as keyof DashboardAnalysisItem] ?? 0;
  const result = typeof left === 'string' ? String(left).localeCompare(String(right)) : Number(left) - Number(right);
  return direction === 'asc' ? result : -result;
}

function headerToSortKey(header: string) {
  if (header === 'bias') return 'directionScore';
  if (header === 'setup') return 'setupQualityScore';
  if (header === 'risk') return 'riskScore';
  if (header === 'R/R') return 'riskReward';
  if (header === 'updated') return 'updatedAt';
  return 'symbol';
}
