import useSWR from 'swr';
import { api } from './endpoints';
import { useUiStore } from '../store/uiStore';

export function useMarketOverview() {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR('market-overview', api.getMarketOverview, { refreshInterval });
}

export function useAnalysisList() {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR('analysis-list', api.getAnalysisList, { refreshInterval });
}

export function useAnalysis(symbol?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  const locale = useUiStore(state => state.locale);
  return useSWR(symbol ? ['analysis', symbol, locale] : null, ([, selected, selectedLocale]) => api.getAnalysis(selected, selectedLocale), { refreshInterval });
}

export function useSnapshots(symbol?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(symbol ? ['snapshots', symbol] : null, ([, selected]) => api.getSnapshots(selected), { refreshInterval });
}

export function useActionableSetups() {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR('actionable-setups', api.getActionableSetups, { refreshInterval });
}

export function useActionableSetupDetail(setupId?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(setupId ? ['actionable-setup-detail', setupId] : null, ([, id]) => api.getActionableSetupDetail(id), { refreshInterval });
}

export function useTacticalSetups() {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR('tactical-setups', api.getTacticalSetups, { refreshInterval });
}

export function useTacticalTimeline(symbol?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(symbol ? ['tactical-timeline', symbol] : null, ([, selected]) => api.getTacticalTimeline(selected), { refreshInterval });
}

export function useMarketFiltersTimeline(symbol?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(symbol ? ['market-filters', symbol] : null, ([, selected]) => api.getMarketFiltersTimeline(selected), { refreshInterval });
}

export function useChartData(symbol?: string, timeframe: '4h' | '1h' = '4h') {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(symbol ? ['chart-data', symbol, timeframe] : null, ([, selected, selectedTimeframe]) => api.getChartData(selected, selectedTimeframe), { refreshInterval });
}

export function useSnapshotAnalytics(symbol?: string) {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  return useSWR(['snapshot-analytics', symbol || 'all'], () => api.getSnapshotAnalytics(symbol), { refreshInterval });
}

export function useAlertSettings() {
  return useSWR('alert-settings', api.getAlertSettings);
}
