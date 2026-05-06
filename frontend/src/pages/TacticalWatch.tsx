import { useTacticalSetups } from '../api/hooks';
import { Link } from 'react-router-dom';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel, pairLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function TacticalWatch() {
  const { data = [], isLoading } = useTacticalSetups();
  const locale = useUiStore(state => state.locale);

  return (
    <Card title="Tactical Entry Watch">
      <p className="mb-4 text-sm text-slate-400">
        1H tactical layer. A CONFIRMED tactical entry does not change the Main 4H decision.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {isLoading && <div className="text-slate-400">Loading tactical setups...</div>}
        {data.map(item => (
          <div key={item.symbol} className="rounded-3xl border border-white/10 bg-black/15 p-5">
            <div className="mb-4 flex items-center justify-between">
              <Link to={`/tactical/${item.symbol}`} className="font-display text-2xl font-bold hover:text-amber-200">{item.symbol}</Link>
              <Badge tone={toneForValue(item.status)}>{pairLabel(item.status, item.side, locale)}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Zone" value={item.zoneFrom ? `${item.zoneFrom} - ${item.zoneTo}` : 'n/a'} />
              <Field label="Zone status" value={enumLabel(item.zoneStatus, locale)} />
              <Field label="Projected R/R" value={formatNumber(item.rr, 2)} />
              <Field label="Candidate stop" value={formatNumber(item.stop, 4)} />
              <Field label="Required entry" value={formatNumber(item.requiredEntryForMinRr, 4)} />
              <Field label="Updated" value={formatDate(item.updatedAt)} />
            </div>
            <p className="mt-4 text-sm text-slate-300">{item.reason}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-3">
      <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-white">{value}</div>
    </div>
  );
}
