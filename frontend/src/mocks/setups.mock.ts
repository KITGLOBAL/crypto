import type { ActionableSetup, TacticalSetupListItem } from '../types/analysis';

export const mockActionableSetups: ActionableSetup[] = [
  {
    setupId: 'BTCUSDT_4H_LONG_BREAKOUT_RETEST_LEVEL_80771.7',
    symbol: 'BTCUSDT',
    timeframe: '4h',
    side: 'LONG',
    from: 80734.4,
    to: 81364.1,
    source: 'BREAKOUT_RETEST_LEVEL',
    status: 'MISSED',
    currentPrice: 81535.9,
    requiredEntryForMinRr: 79484,
    riskReward: 0.5,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  }
];

export const mockTacticalSetups: TacticalSetupListItem[] = [
  {
    symbol: 'BTCUSDT',
    status: 'WATCH',
    side: 'LONG',
    zoneFrom: 79484,
    zoneTo: 80734.4,
    rr: 0.59,
    stop: 78500,
    requiredEntryForMinRr: 79484,
    zoneStatus: 'INVALID_BY_RR',
    reason: '4H bias allows tactical long, but current zone is not tradable.',
    updatedAt: new Date().toISOString()
  }
];
