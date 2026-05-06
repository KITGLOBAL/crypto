import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ActionableStatus, Decision, TacticalStatus } from '../types/analysis';
import type { Locale } from '../utils/i18n';

type SortKey = 'symbol' | 'directionScore' | 'setupQualityScore' | 'riskScore' | 'riskReward' | 'updatedAt';

interface Filters {
  decision: Decision | 'ALL';
  actionableStatus: ActionableStatus | 'ALL';
  tacticalStatus: TacticalStatus | 'ALL';
}

interface UiState {
  selectedSymbol: string;
  filters: Filters;
  sorting: {
    key: SortKey;
    direction: 'asc' | 'desc';
  };
  watchlist: string[];
  refreshInterval: number;
  theme: 'dark' | 'light';
  locale: Locale;
  setSelectedSymbol: (symbol: string) => void;
  setFilter: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  setSorting: (key: SortKey) => void;
  setWatchlist: (symbols: string[]) => void;
  setRefreshInterval: (interval: number) => void;
  setLocale: (locale: Locale) => void;
  toggleTheme: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedSymbol: 'BTCUSDT',
      filters: {
        decision: 'ALL',
        actionableStatus: 'ALL',
        tacticalStatus: 'ALL'
      },
      sorting: {
        key: 'directionScore',
        direction: 'desc'
      },
      watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      refreshInterval: 30_000,
      theme: 'dark',
      locale: 'ru',
      setSelectedSymbol: (selectedSymbol) => set({ selectedSymbol }),
      setFilter: (key, value) => set(state => ({ filters: { ...state.filters, [key]: value } })),
      setSorting: (key) => set(state => ({
        sorting: {
          key,
          direction: state.sorting.key === key && state.sorting.direction === 'desc' ? 'asc' : 'desc'
        }
      })),
      setWatchlist: (watchlist) => set({ watchlist }),
      setRefreshInterval: (refreshInterval) => set({ refreshInterval }),
      setLocale: (locale) => set({ locale }),
      toggleTheme: () => set(state => ({ theme: state.theme === 'dark' ? 'light' : 'dark' }))
    }),
    {
      name: 'crypto-dashboard-ui',
      partialize: state => ({
        selectedSymbol: state.selectedSymbol,
        filters: state.filters,
        sorting: state.sorting,
        watchlist: state.watchlist,
        refreshInterval: state.refreshInterval,
        theme: state.theme,
        locale: state.locale
      })
    }
  )
);
