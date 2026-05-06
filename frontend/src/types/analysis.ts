export type Decision = 'LONG' | 'SHORT' | 'WAIT';
export type PrimaryScenario = 'LONG' | 'SHORT' | 'NEUTRAL';
export type SetupQuality = 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'CHASE';
export type TacticalStatus = 'DISABLED' | 'WATCH' | 'IN_ZONE' | 'CONFIRMATION_PENDING' | 'CONFIRMED' | 'INVALIDATED';
export type TacticalSide = 'LONG' | 'SHORT' | 'NONE';
export type ActionableStatus = 'WATCHING' | 'IN_ZONE' | 'MISSED' | 'INVALID_BY_RR' | 'INVALIDATED' | 'EXPIRED';
export type TrendState = 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'UNCLEAR';

export interface ApiEnvelope<T> {
  apiVersion: 'v1';
  schemaVersion: string;
  data: T;
}

export interface ScoreBreakdownItem {
  category: string;
  score: number;
  max: number;
  explanation: string;
}

export interface DynamicReferenceZone {
  from: number;
  to: number;
  basis: 'CURRENT_PRICE_ATR' | 'CURRENT_PRICE_PERCENT' | 'VOLATILITY_ADJUSTED';
  purpose: 'INFORMATIONAL_ONLY';
}

export interface ActionableEntryZone {
  from: number;
  to: number;
  side: 'LONG' | 'SHORT';
  source: string;
  status: ActionableStatus;
  createdAtCandleTime?: string;
  expiresAt?: string;
  rr?: number;
  isTradable: boolean;
  notTradableReason?: 'NOT_IN_ZONE' | 'RR_BELOW_MINIMUM' | 'INVALIDATED' | 'EXPIRED';
  expirationReason?: string;
  replacementReason?: string;
  setupId: string;
}

export interface ActivationLevels {
  long?: number;
  short?: number;
}

export interface TacticalSetup {
  timeframe: '1h';
  status: TacticalStatus;
  side: TacticalSide;
  reason: string;
  zone?: {
    from: number;
    to: number;
    source: string;
  };
  rr?: number;
  requiredEntryForMinRr?: number;
  zoneStatus?: 'VALID' | 'INVALID_BY_RR' | 'PENDING_RECALCULATION';
  stop?: {
    price: number;
    source: string;
  };
  confirmations: Record<string, boolean>;
  waitingFor: string[];
  invalidation: string[];
  createdAt: string;
}

export interface MainSetup {
  decision: Decision;
  primaryScenario: PrimaryScenario;
  directionScore: number;
  setupQuality: SetupQuality;
  setupQualityScore: number;
  riskScore: number;
  riskReward?: number;
  reason: string;
}

export interface AnalysisContext {
  htfContext: string;
  marketStructure: string;
  volume: string;
  orderFlow: string;
  btc: string;
  btcDominance: string;
  altMarketFilter: string;
  usdtDominance: string;
  derivatives: string;
  riskReward: string;
  volatility: string;
  triggerCandle: string;
  retest: string;
  signalTracking: string;
  retestStatus: string;
  oiWarning: string;
  requiredEntry: string;
}

export interface AnalysisResult {
  symbol: string;
  timeframe: '4h';
  decision: Decision;
  score: number;
  confidence: number;
  tradeConfidence: number | null;
  directionScore: number;
  setupQualityScore: number;
  riskScore: number;
  primaryScenario: PrimaryScenario;
  riskSide: 'LONG' | 'SHORT';
  setupQuality: SetupQuality;
  setupReason: string;
  mainReason: string;
  currentAction: string;
  whyNotNow: string[];
  aiSummary: string;
  marketRegime: string;
  marketState: {
    weeklyTrend: TrendState;
    dailyTrend: TrendState;
    h4Trend: string;
    h1Trend: TrendState;
    btcDailyTrend: TrendState;
    btcH4Trend: TrendState;
  };
  entry: {
    type: string;
    from?: number;
    to?: number;
    currentPrice: number;
  };
  dynamicReferenceZone?: DynamicReferenceZone;
  actionableEntryZone?: ActionableEntryZone;
  activationLevels: ActivationLevels;
  riskManagement: {
    stopLoss?: number;
    takeProfit: number[];
    riskReward?: number;
    invalidation?: string;
    nearestBlockingLevel?: number;
    requiredEntryForMinRr?: number;
    scenarioInvalidation?: string;
  };
  analysis: AnalysisContext;
  categoryScores: ScoreBreakdownItem[];
  reasoning: string[];
  warnings: string[];
  nextConditions: string[];
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reasonForDecision: string;
  tacticalSetup: TacticalSetup;
  createdAt: string;
  strategyVersion: string;
}

export interface AnalysisDetailDto {
  symbol: string;
  timeframe: '4h';
  mainSetup: {
    decision: Decision;
    primaryScenario: PrimaryScenario;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    directionScore: number;
    setupQuality: SetupQuality;
    setupQualityScore: number;
    riskScore: number;
    tradeConfidence: number | null;
    mainReason: string;
    currentAction: string;
    whyNotNow: string[];
  };
  price: {
    current: number;
    updatedAt: string;
  };
  marketState: AnalysisResult['marketState'];
  dynamicReferenceZone?: DynamicReferenceZone;
  actionableEntryZone?: ActionableEntryZone;
  activationLevels: ActivationLevels;
  tacticalSetup: TacticalSetup;
  riskManagement: AnalysisResult['riskManagement'];
  context: AnalysisContext;
  scoreBreakdown: ScoreBreakdownItem[];
  reasoning: string[];
  warnings: string[];
  scenarios: string[];
  summary: string;
  strategyVersion: string;
  schemaVersion: string;
}

export interface AnalysisSnapshot {
  symbol: string;
  timeframe: '4h';
  price: number;
  decision: Decision;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  directionScore: number;
  setupQualityScore: number;
  riskScore: number;
  primaryScenario: PrimaryScenario;
  setupQuality: SetupQuality;
  actionableEntryZoneStatus?: ActionableStatus;
  actionableEntryZoneRr?: number;
  actionableEntryZoneTradable?: boolean;
  actionableEntryZoneSetupId?: string;
  riskReward?: number;
  requiredEntryForMinRr?: number;
  volumeRatio: number;
  fundingRate: number;
  fundingPercentile30d: number;
  openInterestUsd: number;
  oiChange4h: number;
  oiChange24h: number;
  oiChange7d: number;
  longShortRatio: number;
  cvdTrend: 'UP' | 'DOWN' | 'FLAT';
  deltaRatio: number;
  btcDominanceValue: number;
  usdtDominanceValue: number;
  tacticalStatus: TacticalStatus;
  tacticalSide: TacticalSide;
  tacticalRR?: number;
  tacticalStop?: number;
  tacticalZoneStatus?: TacticalSetup['zoneStatus'];
  createdAt: string;
}

export interface DashboardAnalysisItem {
  symbol: string;
  price: number;
  mainDecision: Decision;
  primaryScenario: PrimaryScenario;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  directionScore: number;
  setupQuality: SetupQuality;
  setupQualityScore: number;
  riskScore: number;
  riskReward?: number;
  actionableStatus?: ActionableStatus;
  actionableTradable?: boolean;
  actionableSetupId?: string;
  tacticalStatus?: TacticalStatus;
  tacticalSide?: TacticalSide;
  tacticalRR?: number;
  volumeRatio: number;
  cvdTrend: 'UP' | 'DOWN' | 'FLAT';
  deltaRatio: number;
  fundingRate: number;
  fundingPercentile30d: number;
  oiChange24h: number;
  oiChange7d: number;
  updatedAt: string;
}

export interface MarketOverview {
  btcDominance?: { value: number; updatedAt: string };
  usdtDominance?: { value: number; updatedAt: string };
  totalMarketCapUsd?: { value: number; updatedAt: string };
}

export interface ActionableSetup {
  setupId: string;
  symbol: string;
  timeframe: '4h';
  side: 'LONG' | 'SHORT';
  from: number;
  to: number;
  source: string;
  status: ActionableStatus;
  currentPrice: number;
  requiredEntryForMinRr?: number;
  riskReward?: number;
  expiredReason?: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ActionableSetupDetail {
  setup: ActionableSetup | null;
  timeline: Array<{
    timestamp: string;
    price: number;
    status?: ActionableStatus;
    previousStatus?: ActionableStatus;
    rr?: number;
    tradable?: boolean;
    notTradableReason?: string;
    reason?: string;
    tacticalStatus?: TacticalStatus;
    tacticalSide?: TacticalSide;
  }>;
}

export interface TacticalSetupListItem {
  symbol: string;
  status: TacticalStatus;
  side: TacticalSide;
  zoneFrom?: number;
  zoneTo?: number;
  rr?: number;
  stop?: number;
  requiredEntryForMinRr?: number;
  zoneStatus?: TacticalSetup['zoneStatus'];
  reason?: string;
  updatedAt: string;
}

export interface TacticalTimeline {
  symbol: string;
  timeline: Array<{
    timestamp: string;
    status: TacticalStatus;
    previousStatus?: TacticalStatus;
    side: TacticalSide;
    rr?: number;
    stop?: number;
    zoneFrom?: number;
    zoneTo?: number;
    zoneStatus?: TacticalSetup['zoneStatus'];
    reason?: string;
    confirmations: {
      inZone: boolean;
      rrOk: boolean;
      cvdOk: boolean;
      tacticalConfirmed: boolean;
    };
  }>;
}

export interface MarketFiltersTimeline {
  symbol: string;
  timeline: Array<{
    timestamp: string;
    price: number;
    btcDominanceValue: number;
    btcDominanceTrend: string;
    btcDominanceSlope: string;
    btcDominanceChange4h: number;
    btcDominanceImpact: string;
    usdtDominanceValue: number;
    usdtDominanceTrend: string;
    usdtDominanceSlope: string;
    usdtDominanceChange4h: number;
    usdtDominanceImpact: string;
    btcTrend: string;
    btcH4Trend: string;
  }>;
}

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartZone {
  id: string;
  label: string;
  from: number;
  to: number;
  kind: 'ACTIONABLE' | 'DYNAMIC_REFERENCE' | 'TACTICAL';
  status?: string;
  informationalOnly?: boolean;
}

export interface ChartLevel {
  id: string;
  label: string;
  price: number;
  kind: 'CURRENT_PRICE' | 'SUPPORT' | 'RESISTANCE' | 'ACTIVATION_LONG' | 'ACTIVATION_SHORT' | 'INVALIDATION' | 'STOP_LOSS' | 'TAKE_PROFIT';
}

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  text: string;
}

export interface ChartData {
  symbol: string;
  timeframe: '4h' | '1h';
  candles: ChartCandle[];
  zones: ChartZone[];
  levels: ChartLevel[];
  markers: ChartMarker[];
  panes: {
    volume: Array<{ time: number; value: number; ratio?: number; signal?: string }>;
    orderFlow: Array<{ time: number; deltaRatio: number; cvdTrend: string }>;
    derivatives: Array<{ time: number; fundingRate: number; fundingRank: number; oiChange4h: number; oiChange24h: number; oiChange7d: number }>;
    marketFilters: Array<{ time: number; btcDominance: number; usdtDominance: number; btcDominanceChange4h: number; usdtDominanceChange4h: number }>;
  };
  updatedAt: string;
}

export interface SnapshotAnalytics {
  symbol?: string;
  waitReasons: Array<{ reason: string; count: number }>;
  chaseOutcomes: Array<{ bucket: string; count: number }>;
  tacticalFunnel: Array<{ status: string; count: number }>;
  actionableLifecycle: Array<{ status: string; count: number }>;
  setupTransitions: Array<{ from: string; to: string; count: number }>;
  signalOutcomes: {
    totalSignals: number;
    tp1: number;
    tp2: number;
    sl: number;
    open: number;
    expired: number;
    avgMfePct: number;
    avgMaePct: number;
    avgTimeToTP1Hours?: number;
    avgTimeToSLHours?: number;
  };
  lifecycleQuality: {
    missedThenContinued: number;
    inZoneThenTacticalConfirmed: number;
    chaseSamples: number;
  };
}

export interface AlertSettings {
  id: 'global';
  mainDecisionChanges: boolean;
  actionableInZone: boolean;
  tacticalConfirmed: boolean;
  marketFilterConflict: boolean;
  minRiskReward: number;
  updatedAt: string;
}
