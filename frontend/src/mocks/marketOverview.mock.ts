import type { MarketOverview } from '../types/analysis';

export const mockMarketOverview: MarketOverview = {
  btcDominance: { value: 58.77, updatedAt: new Date().toISOString() },
  usdtDominance: { value: 6.85, updatedAt: new Date().toISOString() },
  totalMarketCapUsd: { value: 2_750_000_000_000, updatedAt: new Date().toISOString() }
};
