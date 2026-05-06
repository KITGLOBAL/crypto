import { request } from './client';
import { adaptAnalysisDetail } from './adapters';
import type {
  ActionableSetup,
  ActionableSetupDetail,
  AlertSettings,
  AnalysisDetailDto,
  AnalysisResult,
  AnalysisSnapshot,
  ChartData,
  DashboardAnalysisItem,
  MarketOverview,
  MarketFiltersTimeline,
  SnapshotAnalytics,
  TacticalTimeline,
  TacticalSetupListItem
} from '../types/analysis';
import { mockAnalysis, mockAnalysisList, mockSnapshots } from '../mocks/analysis.mock';
import { mockMarketOverview } from '../mocks/marketOverview.mock';
import { mockActionableSetups, mockTacticalSetups } from '../mocks/setups.mock';

const useMocks = import.meta.env.VITE_USE_MOCKS === 'true';

export const api = {
  getMarketOverview: () => useMocks ? Promise.resolve(mockMarketOverview) : request<MarketOverview>('/api/market/overview'),
  getAnalysisList: () => useMocks ? Promise.resolve(mockAnalysisList) : request<DashboardAnalysisItem[]>('/api/analysis'),
  getAnalysis: async (symbol: string, locale: 'ru' | 'en' = 'ru') => useMocks
    ? Promise.resolve({ ...mockAnalysis, symbol })
    : adaptAnalysisDetail(await request<AnalysisDetailDto>(`/api/analysis/${symbol}?locale=${locale}`)),
  getSnapshots: (symbol: string) => useMocks ? Promise.resolve(mockSnapshots.map(item => ({ ...item, symbol }))) : request<AnalysisSnapshot[]>(`/api/snapshots/${symbol}`),
  getActionableSetups: () => useMocks ? Promise.resolve(mockActionableSetups) : request<ActionableSetup[]>('/api/actionable-setups'),
  getActionableSetupDetail: (setupId: string) => useMocks ? Promise.resolve({ setup: mockActionableSetups[0], timeline: [] }) : request<ActionableSetupDetail>(`/api/actionable-setups/${encodeURIComponent(setupId)}`),
  getTacticalSetups: () => useMocks ? Promise.resolve(mockTacticalSetups) : request<TacticalSetupListItem[]>('/api/tactical-setups'),
  getTacticalTimeline: (symbol: string) => useMocks ? Promise.resolve({ symbol, timeline: [] }) : request<TacticalTimeline>(`/api/tactical-setups/${symbol}/timeline`),
  getMarketFiltersTimeline: (symbol: string) => useMocks ? Promise.resolve({ symbol, timeline: [] }) : request<MarketFiltersTimeline>(`/api/market/filters/${symbol}`),
  getChartData: (symbol: string, timeframe: '4h' | '1h' = '4h') => useMocks ? Promise.resolve(buildMockChart(symbol, timeframe)) : request<ChartData>(`/api/chart/${symbol}?timeframe=${timeframe}`),
  getSnapshotAnalytics: (symbol?: string) => useMocks ? Promise.resolve(buildMockAnalytics(symbol)) : request<SnapshotAnalytics>(`/api/analytics/snapshots${symbol ? `?symbol=${symbol}` : ''}`),
  getAlertSettings: () => request<AlertSettings>('/api/alert-settings'),
  updateAlertSettings: (patch: Partial<AlertSettings>) => requestWithBody<AlertSettings>('/api/alert-settings', 'PATCH', patch)
};

async function requestWithBody<T>(path: string, method: 'PATCH', body: unknown): Promise<T> {
  const { requestWithBody: send } = await import('./writeClient');
  return send<T>(path, method, body);
}

function buildMockChart(symbol: string, timeframe: '4h' | '1h' = '4h'): ChartData {
  return {
    symbol,
    timeframe,
    candles: mockSnapshots.map((item, index) => ({
      time: Math.floor(new Date(item.createdAt).getTime() / 1000),
      open: item.price - 90,
      high: item.price + 160,
      low: item.price - 180,
      close: item.price,
      volume: 1000 + index * 30
    })),
    zones: [
      { id: 'actionable', label: 'Actionable LONG MISSED', from: 80734.4, to: 81364.1, kind: 'ACTIONABLE', status: 'MISSED' },
      { id: 'dynamic', label: 'Dynamic Reference - informational only', from: 81200, to: 81800, kind: 'DYNAMIC_REFERENCE', informationalOnly: true },
      { id: 'tactical', label: 'Tactical WATCH', from: 79484, to: 80734, kind: 'TACTICAL', status: 'WATCH' }
    ],
    levels: [
      { id: 'current', label: 'Current price', price: 81535.9, kind: 'CURRENT_PRICE' },
      { id: 'long', label: 'Long activation', price: 81745.4, kind: 'ACTIVATION_LONG' },
      { id: 'stop', label: 'Invalidation', price: 79484, kind: 'INVALIDATION' }
    ],
    markers: mockSnapshots.slice(0, 12).map(item => ({
      time: Math.floor(new Date(item.createdAt).getTime() / 1000),
      position: 'belowBar',
      color: '#f59e0b',
      shape: 'circle',
      text: `${item.decision}/${item.actionableEntryZoneStatus || 'N/A'}`
    })),
    panes: {
      volume: mockSnapshots.map((item, index) => ({
        time: Math.floor(new Date(item.createdAt).getTime() / 1000),
        value: 1000 + index * 30
      })),
      orderFlow: mockSnapshots.map(item => ({
        time: Math.floor(new Date(item.createdAt).getTime() / 1000),
        deltaRatio: item.deltaRatio,
        cvdTrend: item.cvdTrend
      })),
      derivatives: mockSnapshots.map(item => ({
        time: Math.floor(new Date(item.createdAt).getTime() / 1000),
        fundingRate: item.fundingRate,
        fundingRank: item.fundingPercentile30d,
        oiChange4h: item.oiChange4h,
        oiChange24h: item.oiChange24h,
        oiChange7d: item.oiChange7d
      })),
      marketFilters: mockSnapshots.map(item => ({
        time: Math.floor(new Date(item.createdAt).getTime() / 1000),
        btcDominance: item.btcDominanceValue,
        usdtDominance: item.usdtDominanceValue,
        btcDominanceChange4h: 0.05,
        usdtDominanceChange4h: -0.03
      }))
    },
    updatedAt: new Date().toISOString()
  };
}

function buildMockAnalytics(symbol?: string): SnapshotAnalytics {
  return {
    symbol,
    waitReasons: [
      { reason: 'RR_BELOW_MINIMUM', count: 18 },
      { reason: 'ENTRY_CHASE', count: 12 },
      { reason: 'ACTIONABLE_MISSED', count: 7 }
    ],
    chaseOutcomes: [
      { bucket: 'SIDEWAYS_NEXT_SNAPSHOT', count: 9 },
      { bucket: 'CONTINUED_UP_1PCT', count: 5 },
      { bucket: 'REVERTED_DOWN_1PCT', count: 4 }
    ],
    tacticalFunnel: [
      { status: 'WATCH', count: 20 },
      { status: 'IN_ZONE', count: 8 },
      { status: 'CONFIRMATION_PENDING', count: 5 },
      { status: 'CONFIRMED', count: 2 }
    ],
    actionableLifecycle: [
      { status: 'WATCHING', count: 10 },
      { status: 'IN_ZONE', count: 4 },
      { status: 'MISSED', count: 8 },
      { status: 'INVALID_BY_RR', count: 6 }
    ],
    setupTransitions: [
      { from: 'WATCHING', to: 'IN_ZONE', count: 4 },
      { from: 'IN_ZONE', to: 'MISSED', count: 3 }
    ],
    signalOutcomes: {
      totalSignals: 12,
      tp1: 5,
      tp2: 2,
      sl: 3,
      open: 4,
      expired: 0,
      avgMfePct: 2.4,
      avgMaePct: 0.9,
      avgTimeToTP1Hours: 9.5
    },
    lifecycleQuality: {
      missedThenContinued: 4,
      inZoneThenTacticalConfirmed: 2,
      chaseSamples: 18
    }
  };
}
