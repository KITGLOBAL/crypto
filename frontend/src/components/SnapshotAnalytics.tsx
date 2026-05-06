import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SnapshotAnalytics as SnapshotAnalyticsType } from '../types/analysis';
import { Card } from './Card';
import { enumLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function SnapshotAnalytics({ analytics }: { analytics?: SnapshotAnalyticsType }) {
  const locale = useUiStore(state => state.locale);
  if (!analytics) {
    return <Card title="Snapshot Analytics">No analytics data yet.</Card>;
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Signal Outcomes">
        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="Total" value={analytics.signalOutcomes.totalSignals} />
          <Stat label="TP1" value={analytics.signalOutcomes.tp1} />
          <Stat label="SL" value={analytics.signalOutcomes.sl} />
          <Stat label="Avg MFE" value={`${analytics.signalOutcomes.avgMfePct}%`} />
          <Stat label="Avg MAE" value={`${analytics.signalOutcomes.avgMaePct}%`} />
          <Stat label="Avg time to TP1" value={analytics.signalOutcomes.avgTimeToTP1Hours ? `${analytics.signalOutcomes.avgTimeToTP1Hours}h` : 'n/a'} />
        </div>
      </Card>
      <Card title="Lifecycle Quality">
        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="CHASE samples" value={analytics.lifecycleQuality.chaseSamples} />
          <Stat label="MISSED then continued" value={analytics.lifecycleQuality.missedThenContinued} />
          <Stat label="IN_ZONE → confirmed" value={analytics.lifecycleQuality.inZoneThenTacticalConfirmed} />
        </div>
      </Card>
      <AnalyticsBar title="WAIT Reason Distribution" data={withLabels(analytics.waitReasons, 'reason', locale)} dataKey="label" />
      <AnalyticsBar title="CHASE Outcomes" data={withLabels(analytics.chaseOutcomes, 'bucket', locale)} dataKey="label" />
      <AnalyticsBar title="Tactical Funnel" data={withLabels(analytics.tacticalFunnel, 'status', locale)} dataKey="label" />
      <AnalyticsBar title="Actionable Lifecycle" data={withLabels(analytics.actionableLifecycle, 'status', locale)} dataKey="label" />
      <Card title="Setup Lifecycle Transitions" className="xl:col-span-2">
        <div className="grid gap-3 md:grid-cols-3">
          {analytics.setupTransitions.length ? analytics.setupTransitions.map(item => (
            <div key={`${item.from}-${item.to}`} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="text-sm text-slate-400">{enumLabel(item.from, locale)} → {enumLabel(item.to, locale)}</div>
              <div className="mt-2 font-display text-3xl font-bold">{item.count}</div>
            </div>
          )) : <div className="text-sm text-slate-500">No transitions captured yet.</div>}
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 font-display text-3xl font-bold">{value}</div>
    </div>
  );
}

function AnalyticsBar({ title, data, dataKey }: { title: string; data: Array<Record<string, string | number>>; dataKey: string }) {
  return (
    <Card title={title}>
      <div className="h-72">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ left: 24, right: 12 }}>
            <CartesianGrid stroke="rgba(148,163,184,0.14)" />
            <XAxis type="number" stroke="#64748b" fontSize={11} />
            <YAxis type="category" dataKey={dataKey} stroke="#64748b" fontSize={11} width={150} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <Bar dataKey="count" fill="#f59e0b" radius={[0, 8, 8, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function withLabels<T extends Record<string, string | number>>(data: T[], key: keyof T, locale: 'ru' | 'en') {
  return data.map(item => ({ ...item, label: enumLabel(item[key], locale) }));
}
