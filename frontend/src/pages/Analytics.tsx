import { useSnapshotAnalytics } from '../api/hooks';
import { SnapshotAnalytics } from '../components/SnapshotAnalytics';

export function Analytics() {
  const { data } = useSnapshotAnalytics();

  return (
    <div className="space-y-4">
      <div>
        <div className="font-display text-3xl font-bold">Snapshot Analytics</div>
        <div className="text-sm text-slate-400">
          Strategy-quality diagnostics built from stored snapshots: WAIT reasons, CHASE outcomes, tactical funnel, and lifecycle transitions.
        </div>
      </div>
      <SnapshotAnalytics analytics={data} />
    </div>
  );
}
