import { useState } from 'react';
import { api } from '../api/endpoints';
import { useAlertSettings } from '../api/hooks';
import { Card } from '../components/Card';
import type { AlertSettings } from '../types/analysis';

export function AlertsSettings() {
  const { data, error, mutate } = useAlertSettings();
  const [saving, setSaving] = useState(false);

  const update = async (patch: Partial<AlertSettings>) => {
    setSaving(true);
    try {
      await mutate(api.updateAlertSettings(patch), { optimisticData: data ? { ...data, ...patch } : undefined, rollbackOnError: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Alerts Settings">
        {error && <p className="mb-4 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">{error.message}</p>}
        {!data && !error && <p className="text-sm text-slate-400">Loading alert settings...</p>}
        <div className="mt-5 space-y-3">
          {data && (
            <>
              <Toggle label="Main 4H decision changes" checked={data.mainDecisionChanges} disabled={saving} onChange={value => update({ mainDecisionChanges: value })} />
              <Toggle label="Actionable zone becomes IN_ZONE" checked={data.actionableInZone} disabled={saving} onChange={value => update({ actionableInZone: value })} />
              <Toggle label="Tactical entry CONFIRMED" checked={data.tacticalConfirmed} disabled={saving} onChange={value => update({ tacticalConfirmed: value })} />
              <Toggle label="BTC.D / USDT.D hard filter conflict" checked={data.marketFilterConflict} disabled={saving} onChange={value => update({ marketFilterConflict: value })} />
              <label className="block rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
                <span className="text-slate-300">Minimum R/R for dashboard alerts</span>
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  max="5"
                  value={data.minRiskReward}
                  disabled={saving}
                  onChange={event => update({ minRiskReward: Number(event.target.value) })}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white outline-none"
                />
              </label>
              <div className="text-xs text-slate-500">Updated: {new Date(data.updatedAt).toLocaleString()}</div>
            </>
          )}
        </div>
      </Card>
      <Card title="Next API Needed">
        <ul className="space-y-3 text-sm text-slate-300">
          <li>GET /api/alert-settings implemented.</li>
          <li>PATCH /api/alert-settings implemented and write-protected.</li>
          <li>Next: per-user auth/session model if dashboard becomes multi-user.</li>
        </ul>
      </Card>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
      {label}
      <input type="checkbox" className="h-4 w-4 accent-amber-400" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    </label>
  );
}
