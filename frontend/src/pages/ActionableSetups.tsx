import { Link } from 'react-router-dom';
import { useActionableSetups } from '../api/hooks';
import { Badge, toneForValue } from '../components/Badge';
import { Card } from '../components/Card';
import { formatDate, formatNumber } from '../utils/format';
import { enumLabel } from '../utils/i18n';
import { useUiStore } from '../store/uiStore';

export function ActionableSetups() {
  const { data = [], isLoading } = useActionableSetups();
  const locale = useUiStore(state => state.locale);

  return (
    <Card title="Actionable Setups Lifecycle">
      <p className="mb-4 text-sm text-slate-400">
        Fixed structural TVH. These zones should not move with price; only lifecycle status and tradability change.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-sm">
          <thead className="text-left text-xs uppercase tracking-[0.2em] text-slate-500">
            <tr>
              {['symbol', 'side', 'zone', 'status', 'R/R', 'current', 'required', 'source', 'expires', 'updated'].map(item => <th key={item} className="px-3 py-2">{item}</th>)}
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={10} className="px-3 py-8 text-slate-400">Loading setups...</td></tr>}
            {data.map(setup => (
              <tr key={setup.setupId} className="bg-white/[0.035]">
                <td className="rounded-l-2xl px-3 py-3 font-bold">
                  <Link to={`/setups/${encodeURIComponent(setup.setupId)}`} className="text-white hover:text-amber-200">{setup.symbol}</Link>
                </td>
                <td className="px-3 py-3"><Badge tone={toneForValue(setup.side)}>{enumLabel(setup.side, locale)}</Badge></td>
                <td className="px-3 py-3">{setup.from} - {setup.to}</td>
                <td className="px-3 py-3"><Badge tone={toneForValue(setup.status)}>{enumLabel(setup.status, locale)}</Badge></td>
                <td className="px-3 py-3">{formatNumber(setup.riskReward, 2)}</td>
                <td className="px-3 py-3">{formatNumber(setup.currentPrice, 4)}</td>
                <td className="px-3 py-3">{formatNumber(setup.requiredEntryForMinRr, 4)}</td>
                <td className="px-3 py-3 text-slate-300">{enumLabel(setup.source, locale)}</td>
                <td className="px-3 py-3 text-slate-400">{formatDate(setup.expiresAt)}</td>
                <td className="rounded-r-2xl px-3 py-3 text-slate-400">{formatDate(setup.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
