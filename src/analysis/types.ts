export type Timeframe = '1w' | '1d' | '4h' | '1h';
export type TrendState = 'UPTREND' | 'DOWNTREND' | 'RANGE' | 'UNCLEAR';
export type Decision = 'LONG' | 'SHORT' | 'WAIT';

export interface Candle {
    symbol: string;
    exchange: string;
    timeframe: Timeframe;
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    quoteVolume: number;
    takerBuyBaseVolume: number;
    takerBuyQuoteVolume: number;
}

export interface SwingPoint {
    index: number;
    time: number;
    price: number;
    type: 'HIGH' | 'LOW';
}

export interface TrendAnalysis {
    trend: TrendState;
    close: number;
    sma20: number;
    sma50: number;
    distanceFromSma20Atr: number;
}

export interface MarketStructureAnalysis {
    trend: TrendState;
    structure: 'BULLISH_STRUCTURE' | 'BEARISH_STRUCTURE' | 'RANGE' | 'UNCLEAR';
    lastSwingHigh?: SwingPoint;
    lastSwingLow?: SwingPoint;
    previousSwingHigh?: SwingPoint;
    previousSwingLow?: SwingPoint;
    bos: 'BULLISH' | 'BEARISH' | 'NONE';
    choch: 'BULLISH' | 'BEARISH' | 'NONE';
}

export interface VolumeAnalysis {
    current: number;
    avg20: number;
    ratio: number;
    trend: 'RISING' | 'FALLING' | 'FLAT';
    signal: 'HIGH_CONFIRMATION' | 'LOW_PARTICIPATION' | 'NORMAL';
    score: number;
}

export interface OrderFlowAnalysis {
    deltaCurrent: number;
    deltaAvg20: number;
    deltaRatio: number;
    deltaStrength: 'STRONG_POSITIVE' | 'STRONG_NEGATIVE' | 'NORMAL';
    cvdChange4h: number;
    cvdChange24h: number;
    cvdTrend: 'UP' | 'DOWN' | 'FLAT';
    divergence: 'BULLISH' | 'BEARISH' | 'NONE';
    impact: string;
    interpretation: string;
    score: number;
}

export interface AtrAnalysis {
    atr14: number;
    atrPercent: number;
}

export interface KeyLevel {
    price: number;
    type: 'support' | 'resistance';
    timeframe: Timeframe;
    strength: number;
    touchCount: number;
    volumeScore: number;
    status: 'ACTIVE' | 'BROKEN' | 'RETESTED' | 'RECLAIMED';
    lastReaction: 'BOUNCE' | 'REJECTION' | 'BREAK' | 'NONE';
    distancePct: number;
}

export interface LevelsAnalysis {
    supports: KeyLevel[];
    resistances: KeyLevel[];
    nearestSupport?: KeyLevel;
    nearestResistance?: KeyLevel;
    rangeLow?: number;
    rangeHigh?: number;
    premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'UNKNOWN';
    summary: string;
}

export interface TriggerCandleAnalysis {
    direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    bodyPct: number;
    upperWickPct: number;
    lowerWickPct: number;
    closeLocation: number;
    volumeRatio: number;
    quality: 'STRONG' | 'ACCEPTABLE' | 'WEAK' | 'REJECTION';
    score: number;
    summary: string;
}

export interface RetestAnalysis {
    direction: 'BULLISH' | 'BEARISH' | 'NONE';
    state: 'CONFIRMED' | 'PENDING' | 'FAILED' | 'NONE';
    level?: number;
    candlesSinceBreakout?: number;
    summary: string;
    score: number;
}

export interface MarketRegimeAnalysis {
    regime: MarketRegime;
    rangePosition: 'LOW' | 'MID' | 'HIGH' | 'UNKNOWN';
    volatilityState: 'EXPANDING' | 'CONTRACTING' | 'NORMAL';
    volumeState: 'RISING' | 'FALLING' | 'FLAT';
    atrCompressionRatio: number;
    summary: string;
    score: number;
}

export interface DominanceAnalysis {
    value: number;
    trend: 'UP' | 'DOWN' | 'RANGE' | 'UNKNOWN';
    slope: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
    positionInRange: 'SUPPORT' | 'MID_RANGE' | 'RESISTANCE' | 'UNKNOWN';
    breakoutStatus: 'BREAKING_UP' | 'BREAKING_DOWN' | 'NO_BREAK' | 'UNKNOWN';
    signalImpact: 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';
    impactDescription: string;
    score: number;
    source: string;
}

export interface MarketContextAnalysis {
    btcDominance: DominanceAnalysis;
    usdtDominance: DominanceAnalysis;
    totalMarketCapUsd: number;
    source: string;
}

export interface DerivativesAnalysis {
    fundingRate: number;
    fundingAvg30d: number;
    fundingZScore30d: number;
    fundingPercentile30d: number;
    openInterestUsd: number;
    longShortRatio: number;
    shortLongRatio: number;
    priceChange4h: number;
    oiChange4h: number;
    oiChange24h: number;
    oiChange7d: number;
    priceOiDivergence: 'BULLISH' | 'BEARISH' | 'LEVERAGE_BUILDUP' | 'DELEVERAGING' | 'NONE';
    oiInterpretation: string;
    fundingInterpretation: string;
    positioningInterpretation: string;
    score: number;
}

export interface CategoryScore {
    category: string;
    score: number;
    max: number;
    explanation: string;
}

export interface EntryPlan {
    type: 'LIMIT_ZONE' | 'MARKET_PULLBACK' | 'NO_TRADE';
    from?: number;
    to?: number;
    currentPrice: number;
}

export interface RiskManagementPlan {
    stopLoss?: number;
    takeProfit: number[];
    riskReward?: number;
    invalidation?: string;
    reason?: string;
    tpBlockedByLevel?: boolean;
    nearestBlockingLevel?: number;
    nearestBlockingLevelDistancePct?: number;
    pathToTpScore?: number;
    pathToTpComment?: string;
    missedRetestEntry?: boolean;
    currentEntryStatus?: 'VALID' | 'MISSED_RETEST' | 'TOO_LATE' | 'WAITING_RETEST' | 'NO_TRADE';
    retestLevel?: number;
    retestEntryComment?: string;
    requiredEntryForMinRr?: number;
    requiredEntryComment?: string;
    scenarioInvalidation?: string;
    pullbackTradeStop?: string;
    breakoutRetestTradeStop?: string;
}

export type SetupQuality = 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'CHASE';
export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGE' | 'COMPRESSION' | 'EXPANSION' | 'DISTRIBUTION' | 'ACCUMULATION' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'UNCLEAR';

export interface SignalOutcome {
    status: 'OPEN' | 'TP1' | 'TP2' | 'TP3' | 'SL' | 'EXPIRED' | 'NO_TRADE';
    maxFavorableExcursionPct: number;
    maxAdverseExcursionPct: number;
    hitTP1: boolean;
    hitTP2: boolean;
    hitSL: boolean;
    timeToTP1Hours?: number;
    timeToSLHours?: number;
    updatedAt: string;
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
    setupQuality: SetupQuality;
    setupReason: string;
    mainReason: string;
    currentAction: string;
    whyNotNow: string[];
    aiSummary: string;
    marketRegime: MarketRegime;
    marketRegimeDetails: MarketRegimeAnalysis;
    marketState: {
        weeklyTrend: TrendState;
        dailyTrend: TrendState;
        h4Trend: string;
        h1Trend: TrendState;
        btcDailyTrend: TrendState;
        btcH4Trend: TrendState;
    };
    entry: EntryPlan;
    riskManagement: RiskManagementPlan;
    analysis: {
        htfContext: string;
        marketStructure: string;
        volume: string;
        orderFlow: string;
        btc: string;
        btcDominance: string;
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
    };
    categoryScores: CategoryScore[];
    reasoning: string[];
    warnings: string[];
    nextConditions: string[];
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    reasonForDecision: string;
    signalOutcome?: SignalOutcome;
    createdAt: string;
    strategyVersion: string;
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
    setupQuality: SetupQuality;
    entryStatus?: RiskManagementPlan['currentEntryStatus'];
    riskReward?: number;
    requiredEntryForMinRr?: number;
    marketRegime: MarketRegime;
    weeklyTrend: TrendState;
    dailyTrend: TrendState;
    h4Structure: string;
    h1Trend: TrendState;
    nearestSupport?: number;
    nearestResistance?: number;
    premiumDiscount?: LevelsAnalysis['premiumDiscount'];
    volumeRatio: number;
    volumeTrend: VolumeAnalysis['trend'];
    triggerQuality: TriggerCandleAnalysis['quality'];
    retestState: RetestAnalysis['state'];
    fundingRate: number;
    fundingPercentile30d: number;
    fundingZScore30d: number;
    openInterestUsd: number;
    oiChange4h: number;
    oiChange24h: number;
    oiChange7d: number;
    priceOiDivergence: DerivativesAnalysis['priceOiDivergence'];
    longShortRatio: number;
    cvdTrend: OrderFlowAnalysis['cvdTrend'];
    deltaRatio: number;
    cvdDivergence: OrderFlowAnalysis['divergence'];
    btcDominanceValue: number;
    btcDominanceTrend: DominanceAnalysis['trend'];
    usdtDominanceValue: number;
    usdtDominanceTrend: DominanceAnalysis['trend'];
    strategyVersion: string;
    createdAt: Date;
}
