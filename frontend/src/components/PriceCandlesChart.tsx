import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  LineStyle
} from 'lightweight-charts';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import type { AnalysisResult, ChartData, ChartLevel, ChartZone } from '../types/analysis';
import { Card } from './Card';
import { useUiStore } from '../store/uiStore';
import { enumLabel } from '../utils/i18n';
import { Badge, toneForValue } from './Badge';
import { formatNumber } from '../utils/format';

export function PriceCandlesChart({
  data,
  analysis,
  timeframe,
  onTimeframeChange
}: {
  data?: ChartData;
  analysis?: AnalysisResult;
  timeframe: '4h' | '1h';
  onTimeframeChange: (timeframe: '4h' | '1h') => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const locale = useUiStore(state => state.locale);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(false);
  const [showDynamic, setShowDynamic] = useState(false);
  const [showAllLevels, setShowAllLevels] = useState(false);
  const visualData = useMemo(() => mergeLiveAnalysisIntoChart(data, analysis), [data, analysis]);
  const displayData = useMemo(
    () => filterChartNoise(visualData, { showMarkers, showDynamic, showAllLevels }),
    [visualData, showMarkers, showDynamic, showAllLevels]
  );

  useEffect(() => {
    if (!ref.current || !displayData?.candles.length) return;

    const container = ref.current;
    const chartHeight = isFullscreen ? Math.max(620, window.innerHeight - 340) : 560;
    container.querySelectorAll('[data-zone-overlay="true"]').forEach(node => node.remove());
    const chart = createChart(container, {
      height: chartHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#cbd5e1'
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.10)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.10)' }
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.2)' },
      timeScale: { borderColor: 'rgba(148, 163, 184, 0.2)', timeVisible: true }
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444'
    });

    candles.setData(displayData.candles.map(item => ({
      time: item.time as any,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close
    })));

    displayData.zones.forEach(zone => {
      addZoneLines(candles, zone);
    });
    displayData.levels.forEach(level => {
      addLevelLine(candles, level);
    });

    createSeriesMarkers(candles, displayData.markers.map(marker => ({
      time: marker.time as any,
      position: marker.position,
      color: marker.color,
      shape: marker.shape,
      text: marker.text
    })));

    const rangeKey = `chart-range:${displayData.symbol}:${displayData.timeframe}`;
    const savedRange = localStorage.getItem(rangeKey);
    if (savedRange) {
      try {
        chart.timeScale().setVisibleRange(JSON.parse(savedRange));
      } catch {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }

    const drawOverlays = () => {
      container.querySelectorAll('[data-zone-overlay="true"]').forEach(node => node.remove());
      displayData.zones.forEach(zone => {
        const top = candles.priceToCoordinate(Math.max(zone.from, zone.to));
        const bottom = candles.priceToCoordinate(Math.min(zone.from, zone.to));
        if (top === null || bottom === null) return;
        const overlay = document.createElement('div');
        overlay.dataset.zoneOverlay = 'true';
        overlay.className = 'pointer-events-auto absolute left-0 right-0 rounded-lg border px-3 py-1 text-xs font-semibold backdrop-blur-sm';
        const style = zoneStyle(zone);
        overlay.style.top = `${Math.min(top, bottom)}px`;
        overlay.style.height = `${Math.max(10, Math.abs(bottom - top))}px`;
        overlay.style.borderColor = style.border;
        overlay.style.background = style.background;
        overlay.style.color = style.color;
        const label = zoneDisplayLabel(zone, locale);
        overlay.title = `${label}\n${zone.from} - ${zone.to}${zone.informationalOnly ? '\nInformational only, not TVH' : ''}`;
        overlay.textContent = label;
        container.appendChild(overlay);
      });
    };
    requestAnimationFrame(drawOverlays);
    chart.timeScale().subscribeVisibleTimeRangeChange(range => {
      if (range) localStorage.setItem(rangeKey, JSON.stringify(range));
      requestAnimationFrame(drawOverlays);
    });

    const resize = () => {
      if (!ref.current) return;
      chart.applyOptions({ width: ref.current.clientWidth });
      requestAnimationFrame(drawOverlays);
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      container.querySelectorAll('[data-zone-overlay="true"]').forEach(node => node.remove());
      chart.remove();
    };
  }, [displayData, locale, isFullscreen]);

  return (
    <div className={isFullscreen ? 'fixed inset-4 z-50 overflow-y-auto rounded-[2rem] border border-white/15 bg-[#09111f] p-5 shadow-2xl shadow-black/70' : ''}>
    <Card title="Price Candles Chart">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(['4h', '1h'] as const).map(value => (
            <button
              key={value}
              onClick={() => onTimeframeChange(value)}
              className={`rounded-2xl border px-4 py-2 text-sm font-semibold transition ${
                timeframe === value ? 'border-amber-300/70 bg-amber-300/15 text-amber-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <ToggleButton active={showDynamic} onClick={() => setShowDynamic(value => !value)}>Dynamic zone</ToggleButton>
          <ToggleButton active={showMarkers} onClick={() => setShowMarkers(value => !value)}>Markers</ToggleButton>
          <ToggleButton active={showAllLevels} onClick={() => setShowAllLevels(value => !value)}>All levels</ToggleButton>
          <button className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10" onClick={() => setIsFullscreen(value => !value)}>
            {isFullscreen ? 'Close fullscreen' : 'Open fullscreen'}
          </button>
        </div>
      </div>
      <div className="mb-5 grid gap-4 xl:grid-cols-[1fr_0.8fr]">
        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-500">Live chart state</div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ChartStat label="Current" value={formatNumber(analysis?.entry.currentPrice, analysis?.entry.currentPrice && analysis.entry.currentPrice > 100 ? 1 : 4)} />
            <ChartStat label="Main 4H" value={enumLabel(analysis?.decision, locale)} tone={toneForValue(analysis?.decision)} />
            <ChartStat label="Actionable" value={enumLabel(analysis?.actionableEntryZone?.status, locale)} tone={toneForValue(analysis?.actionableEntryZone?.status)} />
            <ChartStat label="Tactical" value={enumLabel(analysis?.tacticalSetup.status, locale)} tone={toneForValue(analysis?.tacticalSetup.status)} />
          </div>
        </div>
        <TradeLevels analysis={analysis} locale={locale} />
      </div>

      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400">
        <Legend color="#f59e0b" label="Actionable fixed TVH" />
        <Legend color="#94a3b8" label="Dynamic reference, informational only" dashed />
        <Legend color="#38bdf8" label="Tactical 1H candidate" />
        <Legend color="#ef4444" label="Resistance / invalidation" />
        <Legend color="#10b981" label="TP/SL only when setup is active" />
      </div>
      <div ref={ref} className={`relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black/20 ${isFullscreen ? 'h-[calc(100vh-340px)] min-h-[620px]' : 'h-[560px]'}`} />
      <p className="mt-4 rounded-2xl border border-slate-500/20 bg-slate-500/10 px-4 py-3 text-xs leading-5 text-slate-400">
        Dynamic Reference Zone is informational only. Actionable Entry Zone is fixed by setupId and should not move with live price.
      </p>
      {displayData?.panes && <AdvancedChartPanes data={displayData} />}
    </Card>
    </div>
  );
}

function filterChartNoise(data: ChartData | undefined, options: { showMarkers: boolean; showDynamic: boolean; showAllLevels: boolean }): ChartData | undefined {
  if (!data) return undefined;
  const visibleLevelKinds = new Set(['CURRENT_PRICE', 'SUPPORT', 'RESISTANCE', 'ACTIVATION_LONG', 'ACTIVATION_SHORT', 'STOP_LOSS', 'TAKE_PROFIT']);
  return {
    ...data,
    zones: data.zones.filter(zone => options.showDynamic || zone.kind !== 'DYNAMIC_REFERENCE'),
    levels: options.showAllLevels ? data.levels : data.levels.filter(level => visibleLevelKinds.has(level.kind)),
    markers: options.showMarkers ? data.markers.slice(-24) : []
  };
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border px-4 py-2 text-sm font-semibold transition ${
        active ? 'border-sky-300/70 bg-sky-300/15 text-sky-100' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

function mergeLiveAnalysisIntoChart(data?: ChartData, analysis?: AnalysisResult): ChartData | undefined {
  if (!data) return undefined;
  if (!analysis) return data;

  const zones: ChartZone[] = [
    ...data.zones.filter(zone => zone.kind !== 'ACTIONABLE' && zone.kind !== 'DYNAMIC_REFERENCE' && zone.kind !== 'TACTICAL'),
    analysis.actionableEntryZone ? {
      id: analysis.actionableEntryZone.setupId,
      label: `Actionable ${analysis.actionableEntryZone.side} ${analysis.actionableEntryZone.status}`,
      from: Math.min(analysis.actionableEntryZone.from, analysis.actionableEntryZone.to),
      to: Math.max(analysis.actionableEntryZone.from, analysis.actionableEntryZone.to),
      kind: 'ACTIONABLE',
      status: analysis.actionableEntryZone.status
    } : undefined,
    analysis.dynamicReferenceZone ? {
      id: `${analysis.symbol}-dynamic-reference-live`,
      label: 'Dynamic Reference - informational only',
      from: Math.min(analysis.dynamicReferenceZone.from, analysis.dynamicReferenceZone.to),
      to: Math.max(analysis.dynamicReferenceZone.from, analysis.dynamicReferenceZone.to),
      kind: 'DYNAMIC_REFERENCE',
      informationalOnly: true
    } : undefined,
    analysis.tacticalSetup.zone ? {
      id: `${analysis.symbol}-tactical-live`,
      label: `Tactical ${analysis.tacticalSetup.side} ${analysis.tacticalSetup.status}`,
      from: Math.min(analysis.tacticalSetup.zone.from, analysis.tacticalSetup.zone.to),
      to: Math.max(analysis.tacticalSetup.zone.from, analysis.tacticalSetup.zone.to),
      kind: 'TACTICAL',
      status: analysis.tacticalSetup.status
    } : undefined
  ].filter(Boolean) as ChartZone[];

  const activeTrade = analysis.decision === 'LONG' || analysis.decision === 'SHORT';
  const levels: ChartLevel[] = [
    ...data.levels.filter(level => level.kind !== 'CURRENT_PRICE' && level.kind !== 'STOP_LOSS' && level.kind !== 'TAKE_PROFIT'),
    { id: `${analysis.symbol}-current-live`, label: 'Live current price', price: analysis.entry.currentPrice, kind: 'CURRENT_PRICE' },
    activeTrade && analysis.riskManagement.stopLoss ? { id: `${analysis.symbol}-sl-live`, label: 'Active stop loss', price: analysis.riskManagement.stopLoss, kind: 'STOP_LOSS' } : undefined,
    ...(
      activeTrade
        ? analysis.riskManagement.takeProfit.map((price, index) => ({
          id: `${analysis.symbol}-tp-${index + 1}`,
          label: `TP${index + 1}`,
          price,
          kind: 'TAKE_PROFIT' as const
        }))
        : []
    )
  ].filter(Boolean) as ChartLevel[];

  return { ...data, zones, levels, updatedAt: analysis.createdAt };
}

function ChartStat({ label, value, tone }: { label: string; value: string; tone?: any }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-1">{tone ? <Badge tone={tone}>{value}</Badge> : <span className="font-semibold text-white">{value}</span>}</div>
    </div>
  );
}

function TradeLevels({ analysis, locale }: { analysis?: AnalysisResult; locale: 'ru' | 'en' }) {
  const activeTrade = analysis?.decision === 'LONG' || analysis?.decision === 'SHORT';
  return (
    <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
      <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-500">Trade levels</div>
      {activeTrade ? (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between gap-3"><span className="text-slate-400">Stop loss</span><span className="font-semibold">{formatNumber(analysis.riskManagement.stopLoss, 4)}</span></div>
          <div className="flex justify-between gap-3"><span className="text-slate-400">TP</span><span className="text-right font-semibold">{analysis.riskManagement.takeProfit.map(tp => formatNumber(tp, 4)).join(' / ')}</span></div>
          <div className="flex justify-between gap-3"><span className="text-slate-400">R/R</span><span className="font-semibold">{formatNumber(analysis.riskManagement.riskReward, 2)}</span></div>
        </div>
      ) : (
        <div className="space-y-2 text-sm leading-6 text-slate-300">
          <Badge tone="gray">{enumLabel('WAIT', locale)}</Badge>
          <p>TP/SL не активны, пока Main 4H setup = WAIT. Потенциальная геометрия используется только для оценки R/R и не является торговым планом.</p>
        </div>
      )}
    </div>
  );
}

function zoneDisplayLabel(zone: ChartZone, locale: 'ru' | 'en') {
  if (zone.kind === 'ACTIONABLE') return `Actionable ${enumLabel(zone.status, locale)}`;
  if (zone.kind === 'TACTICAL') return `Tactical ${enumLabel(zone.status, locale)}`;
  return locale === 'ru' ? 'Dynamic Reference, не ТВХ' : 'Dynamic Reference, not TVH';
}

function AdvancedChartPanes({ data }: { data: ChartData }) {
  return (
    <div className="mt-5 grid gap-4 xl:grid-cols-2">
      <Pane title="Volume">
        <BarChart data={data.panes.volume.map(item => ({ ...item, label: formatPaneTime(item.time) }))}>
          <CartesianGrid stroke="rgba(148,163,184,0.14)" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
        </BarChart>
      </Pane>

      <Pane title="CVD / Delta">
        <LineChart data={data.panes.orderFlow.map(item => ({ ...item, label: formatPaneTime(item.time) }))}>
          <CartesianGrid stroke="rgba(148,163,184,0.14)" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="deltaRatio" name="Delta ratio" stroke="#38bdf8" strokeWidth={2} dot={false} />
        </LineChart>
      </Pane>

      <Pane title="Funding / Funding Rank">
        <LineChart data={data.panes.derivatives.map(item => ({ ...item, fundingPct: item.fundingRate * 100, label: formatPaneTime(item.time) }))}>
          <CartesianGrid stroke="rgba(148,163,184,0.14)" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="fundingPct" name="Funding %" stroke="#f472b6" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="fundingRank" name="Funding rank" stroke="#a78bfa" strokeWidth={2} dot={false} />
        </LineChart>
      </Pane>

      <Pane title="OI Changes">
        <LineChart data={data.panes.derivatives.map(item => ({ ...item, label: formatPaneTime(item.time) }))}>
          <CartesianGrid stroke="rgba(148,163,184,0.14)" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="oiChange4h" name="OI 4H %" stroke="#38bdf8" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="oiChange24h" name="OI 24H %" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="oiChange7d" name="OI 7D %" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </LineChart>
      </Pane>

      <Pane title="BTC.D / USDT.D" wide>
        <LineChart data={data.panes.marketFilters.map(item => ({ ...item, label: formatPaneTime(item.time) }))}>
          <CartesianGrid stroke="rgba(148,163,184,0.14)" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="btcDominance" name="BTC.D" stroke="#f59e0b" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="usdtDominance" name="USDT.D" stroke="#38bdf8" strokeWidth={2} dot={false} />
        </LineChart>
      </Pane>
    </div>
  );
}

function Pane({ title, children, wide = false }: { title: string; children: ReactElement; wide?: boolean }) {
  return (
    <div className={`rounded-3xl border border-white/10 bg-black/15 p-5 ${wide ? 'xl:col-span-2' : ''}`}>
      <div className="mb-4 text-xs uppercase tracking-[0.18em] text-slate-500">{title}</div>
      <div className="h-64">
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

const tooltipStyle = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 14
};

function formatPaneTime(time: number) {
  return new Date(time * 1000).toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

function zoneStyle(zone: ChartZone) {
  if (zone.kind === 'ACTIONABLE') {
    const danger = ['MISSED', 'INVALID_BY_RR', 'INVALIDATED', 'EXPIRED'].includes(zone.status || '');
    return {
      border: danger ? 'rgba(248, 113, 113, 0.8)' : 'rgba(245, 158, 11, 0.9)',
      background: danger ? 'rgba(248, 113, 113, 0.10)' : 'rgba(245, 158, 11, 0.16)',
      color: danger ? '#fecaca' : '#fde68a'
    };
  }
  if (zone.kind === 'TACTICAL') {
    return { border: 'rgba(56, 189, 248, 0.75)', background: 'rgba(56, 189, 248, 0.11)', color: '#bae6fd' };
  }
  return { border: 'rgba(148, 163, 184, 0.55)', background: 'rgba(148, 163, 184, 0.07)', color: '#cbd5e1' };
}

function addZoneLines(series: any, zone: ChartZone) {
  const color = zone.kind === 'ACTIONABLE'
    ? '#f59e0b'
    : zone.kind === 'TACTICAL'
      ? '#38bdf8'
      : '#94a3b8';
  const lineStyle = zone.kind === 'DYNAMIC_REFERENCE' ? LineStyle.LargeDashed : LineStyle.Solid;
  series.createPriceLine({
    price: zone.from,
    color,
    lineWidth: 2,
    lineStyle,
    axisLabelVisible: false,
    title: ''
  });
  series.createPriceLine({
    price: zone.to,
    color,
    lineWidth: 2,
    lineStyle,
    axisLabelVisible: false,
    title: ''
  });
}

function addLevelLine(series: any, level: ChartLevel) {
  const color = level.kind === 'CURRENT_PRICE'
    ? '#e5e7eb'
    : level.kind === 'SUPPORT'
      ? '#22c55e'
      : level.kind === 'TAKE_PROFIT'
        ? '#10b981'
        : level.kind === 'RESISTANCE' || level.kind === 'INVALIDATION' || level.kind === 'STOP_LOSS'
        ? '#ef4444'
        : '#a78bfa';
  series.createPriceLine({
    price: level.price,
    color,
    lineWidth: 1,
    lineStyle: level.kind === 'CURRENT_PRICE' ? LineStyle.Solid : LineStyle.Dashed,
    axisLabelVisible: true,
    title: level.label
  });
}

function Legend({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-0 w-8 border-t-2 ${dashed ? 'border-dashed' : ''}`} style={{ borderColor: color }} />
      {label}
    </span>
  );
}
