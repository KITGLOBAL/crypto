import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useAnalysis, useChartData, useSnapshotAnalytics, useSnapshots } from '../api/hooks';
import { ErrorState } from '../components/AsyncState';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { LifecycleChart, MarketMetricsChart, RiskRewardChart, ScoreDynamicsChart } from '../components/Charts';
import { PriceCandlesChart } from '../components/PriceCandlesChart';
import { SnapshotAnalytics } from '../components/SnapshotAnalytics';
import { MarketFiltersPanel } from '../components/MarketFiltersPanel';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function SymbolDetail() {
  const { symbol = 'BTCUSDT' } = useParams();
  const [chartTimeframe, setChartTimeframe] = useState<'4h' | '1h'>('4h');
  const { data: analysis, isLoading, error } = useAnalysis(symbol);
  const { data: snapshots = [] } = useSnapshots(symbol);
  const { data: chartData, error: chartError } = useChartData(symbol, chartTimeframe);
  const { data: analytics } = useSnapshotAnalytics(symbol);
  const locale = useUiStore(state => state.locale);

  if (error) {
    return <ErrorState title={`Failed to load ${symbol}`} error={error} />;
  }
  if (isLoading || !analysis) {
    return <Card>Loading {symbol} analysis...</Card>;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-sm uppercase tracking-[0.25em] text-amber-300">MTF Analysis — 4H Setup</div>
              <h1 className="mt-2 font-display text-4xl font-bold">{analysis.symbol}</h1>
              <p className="mt-2 max-w-3xl text-slate-300">{analysis.mainReason}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={toneForValue(analysis.decision)}>Main 4H: {enumLabel(analysis.decision, locale)}</Badge>
              <Badge tone={toneForValue(analysis.bias)}>Bias: {enumLabel(analysis.bias, locale)} {analysis.directionScore}</Badge>
              <Badge tone={toneForValue(analysis.setupQuality)}>Setup: {enumLabel(analysis.setupQuality, locale)}</Badge>
            </div>
          </div>
        </Card>

        <Card title="Current Price">
          <div className="font-display text-4xl font-bold">{formatNumber(analysis.entry.currentPrice, analysis.entry.currentPrice > 100 ? 1 : 4)}</div>
          <div className="mt-2 text-sm text-slate-400">Updated {formatDate(analysis.createdAt)}</div>
        </Card>
      </div>

      <Card title="Summary">
        <div className="whitespace-pre-line text-sm leading-7 text-slate-200">{analysis.aiSummary || analysis.reasonForDecision}</div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Main 4H Setup">
          <Metric label="Decision" value={enumLabel(analysis.decision, locale)} tone={toneForValue(analysis.decision)} />
          <Metric label="Technical Bias" value={`${enumLabel(analysis.bias, locale)} ${analysis.directionScore}/100`} tone={toneForValue(analysis.bias)} />
          <Metric label="Setup Quality" value={`${enumLabel(analysis.setupQuality, locale)} ${analysis.setupQualityScore}/100`} tone={toneForValue(analysis.setupQuality)} />
          <Metric label="Risk Quality" value={`${analysis.riskScore}/100`} />
          <Metric label="R/R" value={formatNumber(analysis.riskManagement.riskReward, 2)} />
        </Card>

        <Card title="Actionable Entry Zone">
          {analysis.actionableEntryZone ? (
            <>
              <Metric label="Setup ID" value={analysis.actionableEntryZone.setupId} />
              <Metric label="Side" value={enumLabel(analysis.actionableEntryZone.side, locale)} tone={toneForValue(analysis.actionableEntryZone.side)} />
              <Metric label="Fixed Zone" value={`${analysis.actionableEntryZone.from} - ${analysis.actionableEntryZone.to}`} />
              <Metric label="Status" value={enumLabel(analysis.actionableEntryZone.status, locale)} tone={toneForValue(analysis.actionableEntryZone.status)} />
              <Metric label="Tradable" value={analysis.actionableEntryZone.isTradable ? enumLabel('YES', locale) : `${enumLabel('NO', locale)} ${enumLabel(analysis.actionableEntryZone.notTradableReason, locale)}`} tone={analysis.actionableEntryZone.isTradable ? 'green' : 'gray'} />
              <Metric label="R/R now" value={formatNumber(analysis.actionableEntryZone.rr, 2)} />
            </>
          ) : (
            <p className="text-sm text-slate-400">N/A — no directional edge. Use activation levels instead.</p>
          )}
        </Card>

        <Card title="Tactical Entry Watch">
          <Metric label="Status" value={enumLabel(analysis.tacticalSetup.status, locale)} tone={toneForValue(analysis.tacticalSetup.status)} />
          <Metric label="Side" value={enumLabel(analysis.tacticalSetup.side, locale)} tone={toneForValue(analysis.tacticalSetup.side)} />
          <Metric label="Zone" value={analysis.tacticalSetup.zone ? `${analysis.tacticalSetup.zone.from} - ${analysis.tacticalSetup.zone.to}` : 'n/a'} />
          <Metric label="Projected R/R" value={formatNumber(analysis.tacticalSetup.rr, 2)} />
          <Metric label="Stop" value={formatNumber(analysis.tacticalSetup.stop?.price, 4)} />
          <p className="mt-3 text-sm text-slate-300">{analysis.tacticalSetup.reason}</p>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Dynamic Reference Zone">
          <div className="rounded-2xl border border-dashed border-slate-500/40 bg-slate-500/10 p-4">
            {analysis.dynamicReferenceZone ? (
              <>
                <div className="font-display text-2xl font-bold text-slate-200">{analysis.dynamicReferenceZone.from} - {analysis.dynamicReferenceZone.to}</div>
                <div className="mt-2 text-sm text-slate-400">Purpose: {enumLabel(analysis.dynamicReferenceZone.purpose, locale)}. This is not TVH and can move with live price.</div>
              </>
            ) : <div className="text-sm text-slate-400">No dynamic reference zone.</div>}
          </div>
        </Card>

        <Card title="Activation Levels">
          <Metric label="Long breakout activation" value={analysis.activationLevels.long ? `4H close above ${analysis.activationLevels.long} + retest` : 'n/a'} />
          <Metric label="Short breakdown activation" value={analysis.activationLevels.short ? `4H close below / rejection near ${analysis.activationLevels.short} + retest` : 'n/a'} />
        </Card>

        <Card title="Risk / TP Plan">
          {analysis.decision === 'WAIT' ? (
            <div className="space-y-3 text-sm leading-6 text-slate-300">
              <Badge tone="gray">Inactive while WAIT</Badge>
              <p>TP/SL не выставляются, пока Main 4H setup = WAIT. Эти уровни появляются как active trade plan только при LONG/SHORT.</p>
              <Metric label="Current R/R geometry" value={formatNumber(analysis.riskManagement.riskReward, 2)} />
              <Metric label="Required entry" value={formatNumber(analysis.riskManagement.requiredEntryForMinRr, 4)} />
            </div>
          ) : (
            <>
              <Metric label="Stop loss" value={formatNumber(analysis.riskManagement.stopLoss, 4)} />
              <Metric label="Take profits" value={analysis.riskManagement.takeProfit.map(tp => formatNumber(tp, 4)).join(' / ')} />
              <Metric label="Invalidation" value={analysis.riskManagement.invalidation || analysis.riskManagement.scenarioInvalidation || 'n/a'} />
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ContextCards analysis={analysis.analysis as unknown as Record<string, string>} />
        <MarketFiltersPanel symbol={symbol} />
      </div>

      <div className="grid gap-4 xl:grid-cols-1">
        <Card title="Score Breakdown">
          <div className="space-y-3">
            {analysis.categoryScores.map(item => (
              <div key={item.category}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{item.category}</span>
                  <span>{item.score}/{item.max}</span>
                </div>
                <div className="h-2 rounded-full bg-white/10">
                  <div className="h-2 rounded-full bg-amber-400" style={{ width: `${Math.min(100, Math.abs(item.score / item.max) * 100)}%` }} />
                </div>
                <div className="mt-1 text-xs text-slate-500">{item.explanation}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Why WAIT / Warnings / Scenarios">
        <div className="grid gap-4 xl:grid-cols-3">
          <List title="Why Not Now" items={analysis.whyNotNow} />
          <List title="Warnings" items={analysis.warnings} />
          <List title="Next Conditions" items={analysis.nextConditions} />
        </div>
      </Card>

      <section className="space-y-4">
        <div>
          <div className="font-display text-2xl font-bold">Charts & Snapshot Analytics</div>
          <div className="text-sm text-slate-400">Candles use fixed actionable setup overlays and snapshot lifecycle markers.</div>
        </div>
        {chartError && <ErrorState title="Chart data failed" error={chartError} />}
        <PriceCandlesChart data={chartData} analysis={analysis} timeframe={chartTimeframe} onTimeframeChange={setChartTimeframe} />
        <div className="grid gap-4 xl:grid-cols-2">
          <ScoreDynamicsChart snapshots={snapshots} />
          <RiskRewardChart snapshots={snapshots} />
          <LifecycleChart snapshots={snapshots} />
          <MarketMetricsChart snapshots={snapshots} />
        </div>
        <SnapshotAnalytics analytics={analytics} />
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: any }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4 border-b border-white/5 pb-3 text-sm">
      <span className="text-slate-400">{label}</span>
      {tone ? <Badge tone={tone}>{value}</Badge> : <span className="max-w-[70%] text-right font-semibold text-white">{value}</span>}
    </div>
  );
}

function ContextCards({ analysis }: { analysis: Record<string, string> }) {
  return (
    <Card title="Context Cards">
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(analysis).slice(0, 10).map(([key, value]) => (
          <div key={key} className="rounded-2xl border border-white/10 bg-black/15 p-3">
            <div className="mb-1 text-xs uppercase tracking-[0.18em] text-slate-500">{key}</div>
            <div className="text-sm text-slate-200">{value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-3 font-display font-semibold">{title}</h3>
      <ul className="space-y-2 text-sm text-slate-300">
        {items.length ? items.map(item => <li key={item} className="rounded-xl bg-white/[0.04] px-3 py-2">{item}</li>) : <li className="text-slate-500">No items.</li>}
      </ul>
    </div>
  );
}
