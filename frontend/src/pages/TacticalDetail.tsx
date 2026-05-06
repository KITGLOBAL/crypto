import { useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTacticalTimeline } from '../api/hooks';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { ErrorState } from '../components/AsyncState';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel, pairLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function TacticalDetail() {
  const { symbol = '' } = useParams();
  const { data, error, isLoading } = useTacticalTimeline(symbol);
  const locale = useUiStore(state => state.locale);

  if (error) return <ErrorState title="Failed to load tactical timeline" error={error} />;
  if (isLoading || !data) return <Card>Loading tactical timeline...</Card>;

  const chartData = data.timeline.map(item => ({
    ...item,
    time: formatDate(item.timestamp),
    statusIndex: ['DISABLED', 'WATCH', 'IN_ZONE', 'CONFIRMATION_PENDING', 'CONFIRMED', 'INVALIDATED'].indexOf(item.status) + 1
  }));

  return (
    <div className="space-y-5">
      <Card title={`Tactical Detail — ${data.symbol}`}>
        <p className="text-sm text-slate-400">1H tactical layer. It explains WATCH / IN_ZONE / CONFIRMATION_PENDING without changing Main 4H decision.</p>
      </Card>
      <Card title="Tactical Status Timeline">
        <div className="h-72">
          <ResponsiveContainer>
            <BarChart data={chartData}>
              <CartesianGrid stroke="rgba(148,163,184,0.14)" />
              <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
              <Bar dataKey="statusIndex" fill="#38bdf8" radius={[8, 8, 0, 0]} />
              <Bar dataKey="rr" fill="#f59e0b" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="Confirmation Events">
        <div className="space-y-2">
          {data.timeline.map(item => (
            <div key={item.timestamp} className="rounded-2xl bg-white/[0.04] p-4 text-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <span className="text-slate-400">{formatDate(item.timestamp)}</span>
                <Badge tone={toneForValue(item.status)}>{pairLabel(item.status, item.side, locale)}</Badge>
                <span>R/R {formatNumber(item.rr, 2)}</span>
                <span>Stop {formatNumber(item.stop, 4)}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-4">
                {Object.entries(item.confirmations).map(([key, value]) => (
                  <Badge key={key} tone={value ? 'green' : 'gray'}>{key}: {value ? enumLabel('YES', locale) : enumLabel('NO', locale)}</Badge>
                ))}
              </div>
              {item.reason && <p className="mt-3 text-slate-300">{item.reason}</p>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
