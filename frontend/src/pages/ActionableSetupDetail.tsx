import { useParams } from 'react-router-dom';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { useActionableSetupDetail } from '../api/hooks';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { ErrorState } from '../components/AsyncState';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function ActionableSetupDetail() {
  const { setupId = '' } = useParams();
  const { data, error, isLoading } = useActionableSetupDetail(setupId);
  const locale = useUiStore(state => state.locale);

  if (error) return <ErrorState title="Failed to load setup lifecycle" error={error} />;
  if (isLoading || !data) return <Card>Loading setup lifecycle...</Card>;
  if (!data.setup) return <Card>Setup not found.</Card>;

  const chartData = data.timeline.map(item => ({
    ...item,
    time: formatDate(item.timestamp),
    statusIndex: statusIndex(item.status)
  }));

  return (
    <div className="space-y-5">
      <Card title="Actionable Setup Detail">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Setup ID" value={data.setup.setupId} />
          <Field label="Symbol" value={data.setup.symbol} />
          <Field label="Side" value={enumLabel(data.setup.side, locale)} />
          <Field label="Fixed Zone" value={`${data.setup.from} - ${data.setup.to}`} />
          <Field label="Status" value={<Badge tone={toneForValue(data.setup.status)}>{enumLabel(data.setup.status, locale)}</Badge>} />
          <Field label="R/R" value={formatNumber(data.setup.riskReward, 2)} />
          <Field label="Source" value={enumLabel(data.setup.source, locale)} />
          <Field label="Expired Reason" value={enumLabel(data.setup.expiredReason, locale)} />
          <Field label="Updated" value={formatDate(data.setup.updatedAt)} />
        </div>
      </Card>

      <Card title="Lifecycle Timeline">
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="rgba(148,163,184,0.14)" />
              <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
              <Line type="monotone" dataKey="price" stroke="#38bdf8" strokeWidth={2} dot={false} />
              <Line type="stepAfter" dataKey="statusIndex" stroke="#f59e0b" strokeWidth={2} />
              <Line type="monotone" dataKey="rr" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Status Events">
        <div className="space-y-2">
          {data.timeline.map(item => (
            <div key={item.timestamp} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm">
              <span className="text-slate-400">{formatDate(item.timestamp)}</span>
              <Badge tone={toneForValue(item.status)}>{enumLabel(item.status, locale)}</Badge>
              <span>Price {formatNumber(item.price, item.price > 100 ? 1 : 4)}</span>
              <span>R/R {formatNumber(item.rr, 2)}</span>
              <span>{item.tradable ? 'tradable' : enumLabel(item.reason || item.notTradableReason, locale)}</span>
              <Badge tone={toneForValue(item.tacticalStatus)}>{enumLabel(item.tacticalStatus, locale)}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 break-all font-semibold text-white">{value}</div>
    </div>
  );
}

function statusIndex(status?: string) {
  return ['WATCHING', 'IN_ZONE', 'MISSED', 'INVALID_BY_RR', 'INVALIDATED', 'EXPIRED'].indexOf(status || '') + 1;
}
