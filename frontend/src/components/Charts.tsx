import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import type { AnalysisSnapshot } from '../types/analysis';
import { Card } from './Card';
import { formatDate } from '../utils/format';

const axis = { stroke: '#64748b', fontSize: 11 };
const grid = { stroke: 'rgba(148,163,184,0.16)' };

export function ScoreDynamicsChart({ snapshots }: { snapshots: AnalysisSnapshot[] }) {
  const data = normalize(snapshots);
  return (
    <Card title="Bias / Setup / Risk Dynamics">
      <div className="h-72">
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="time" {...axis} />
            <YAxis {...axis} domain={[-100, 100]} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <Line type="monotone" dataKey="directionScore" stroke="#38bdf8" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="setupQualityScore" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="riskScore" stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function RiskRewardChart({ snapshots }: { snapshots: AnalysisSnapshot[] }) {
  const data = normalize(snapshots);
  return (
    <Card title="R/R Dynamics">
      <div className="h-72">
        <ResponsiveContainer>
          <AreaChart data={data}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="time" {...axis} />
            <YAxis {...axis} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <ReferenceLine y={1.8} stroke="#f59e0b" strokeDasharray="6 6" label="min 1.8" />
            <Area type="monotone" dataKey="riskReward" stroke="#38bdf8" fill="#38bdf833" />
            <Area type="monotone" dataKey="actionableEntryZoneRr" stroke="#10b981" fill="#10b98122" />
            <Line type="monotone" dataKey="tacticalRR" stroke="#f472b6" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function MarketMetricsChart({ snapshots }: { snapshots: AnalysisSnapshot[] }) {
  const data = normalize(snapshots);
  return (
    <Card title="Market Metrics">
      <div className="h-72">
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="time" {...axis} />
            <YAxis {...axis} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <Line type="monotone" dataKey="volumeRatio" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="deltaRatio" stroke="#38bdf8" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="oiChange24h" stroke="#10b981" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="fundingPercentile30d" stroke="#f472b6" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function LifecycleChart({ snapshots }: { snapshots: AnalysisSnapshot[] }) {
  const statusIndex = ['WATCHING', 'IN_ZONE', 'MISSED', 'INVALID_BY_RR', 'INVALIDATED', 'EXPIRED'];
  const tacticalIndex = ['DISABLED', 'WATCH', 'IN_ZONE', 'CONFIRMATION_PENDING', 'CONFIRMED', 'INVALIDATED'];
  const data = normalize(snapshots).map(item => ({
    ...item,
    actionableState: item.actionableEntryZoneStatus ? statusIndex.indexOf(item.actionableEntryZoneStatus) + 1 : 0,
    tacticalState: item.tacticalStatus ? tacticalIndex.indexOf(item.tacticalStatus) + 1 : 0
  }));

  return (
    <Card title="Actionable / Tactical Lifecycle">
      <div className="h-72">
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="time" {...axis} />
            <YAxis {...axis} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14 }} />
            <Bar dataKey="actionableState" fill="#f59e0b" radius={[6, 6, 0, 0]} />
            <Bar dataKey="tacticalState" fill="#38bdf8" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function normalize(snapshots: AnalysisSnapshot[]) {
  return [...snapshots]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(item => ({ ...item, time: formatDate(item.createdAt) }));
}
