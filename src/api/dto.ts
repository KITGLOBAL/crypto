import type {
    ActionableEntryZone,
    AnalysisResult,
    AnalysisSnapshot,
    Decision,
    PrimaryScenario,
    SetupQuality,
    TacticalSetup
} from '../analysis/types';
import type { DashboardAlertSettings } from '../services/DatabaseService';

export interface ApiEnvelope<T> {
    apiVersion: 'v1';
    schemaVersion: string;
    data: T;
}

export interface HealthDto {
    status: 'ok';
    apiVersion: 'v1';
    schemaVersion: string;
    uptimeSeconds: number;
}

export interface DashboardAnalysisItemDto {
    symbol: string;
    price: number;
    mainDecision: Decision;
    primaryScenario: PrimaryScenario;
    bias: AnalysisSnapshot['bias'];
    directionScore: number;
    setupQuality: SetupQuality;
    setupQualityScore: number;
    riskScore: number;
    riskReward?: number;
    actionableStatus?: ActionableEntryZone['status'];
    actionableTradable?: boolean;
    actionableSetupId?: string;
    tacticalStatus?: TacticalSetup['status'];
    tacticalSide?: TacticalSetup['side'];
    tacticalRR?: number;
    volumeRatio: number;
    cvdTrend: AnalysisSnapshot['cvdTrend'];
    deltaRatio: number;
    fundingRate: number;
    fundingPercentile30d: number;
    oiChange24h: number;
    oiChange7d: number;
    updatedAt: string;
}

export interface MarketOverviewDto {
    btcDominance?: {
        value: number;
        updatedAt: string;
    };
    usdtDominance?: {
        value: number;
        updatedAt: string;
    };
    totalMarketCapUsd?: {
        value: number;
        updatedAt: string;
    };
}

export interface AnalysisResultDto {
    symbol: string;
    timeframe: '4h';
    mainSetup: {
        decision: Decision;
        primaryScenario: PrimaryScenario;
        bias: AnalysisResult['bias'];
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
    dynamicReferenceZone?: AnalysisResult['dynamicReferenceZone'];
    actionableEntryZone?: ActionableEntryZone;
    activationLevels: AnalysisResult['activationLevels'];
    tacticalSetup: TacticalSetup;
    riskManagement: AnalysisResult['riskManagement'];
    context: AnalysisResult['analysis'];
    scoreBreakdown: AnalysisResult['categoryScores'];
    reasoning: string[];
    warnings: string[];
    scenarios: string[];
    summary: string;
    strategyVersion: string;
    schemaVersion: string;
}
export type AnalysisSnapshotDto = AnalysisSnapshot;

export interface ActionableSetupDto {
    setupId: string;
    symbol: string;
    timeframe: '4h';
    side: ActionableEntryZone['side'];
    from: number;
    to: number;
    source: ActionableEntryZone['source'];
    status: ActionableEntryZone['status'];
    currentPrice: number;
    requiredEntryForMinRr?: number;
    riskReward?: number;
    stopLoss?: number;
    target?: number;
    invalidation?: string;
    replacedBySetupId?: string;
    expiredReason?: string;
    createdAtCandleTime: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface ActionableSetupDetailDto {
    setup: ActionableSetupDto;
    timeline: Array<{
        timestamp: string;
        price: number;
        status?: ActionableEntryZone['status'];
        previousStatus?: ActionableEntryZone['status'];
        rr?: number;
        tradable?: boolean;
        notTradableReason?: string;
        reason?: string;
        tacticalStatus?: TacticalSetup['status'];
        tacticalSide?: TacticalSetup['side'];
    }>;
}

export interface TacticalSetupDto {
    symbol: string;
    status: TacticalSetup['status'];
    side: TacticalSetup['side'];
    zoneFrom?: number;
    zoneTo?: number;
    rr?: number;
    stop?: number;
    requiredEntryForMinRr?: number;
    zoneStatus?: TacticalSetup['zoneStatus'];
    reason?: string;
    updatedAt: string;
}

export interface TacticalTimelineDto {
    symbol: string;
    timeline: Array<{
        timestamp: string;
        status: TacticalSetup['status'];
        previousStatus?: TacticalSetup['status'];
        side: TacticalSetup['side'];
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

export interface MarketFiltersTimelineDto {
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

export interface ChartCandleDto {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface ChartZoneDto {
    id: string;
    label: string;
    from: number;
    to: number;
    kind: 'ACTIONABLE' | 'DYNAMIC_REFERENCE' | 'TACTICAL';
    status?: string;
    informationalOnly?: boolean;
}

export interface ChartLevelDto {
    id: string;
    label: string;
    price: number;
    kind: 'CURRENT_PRICE' | 'SUPPORT' | 'RESISTANCE' | 'ACTIVATION_LONG' | 'ACTIVATION_SHORT' | 'INVALIDATION' | 'STOP_LOSS' | 'TAKE_PROFIT';
}

export interface ChartMarkerDto {
    time: number;
    position: 'aboveBar' | 'belowBar' | 'inBar';
    color: string;
    shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
    text: string;
}

export interface ChartDataDto {
    symbol: string;
    timeframe: '4h' | '1h';
    candles: ChartCandleDto[];
    zones: ChartZoneDto[];
    levels: ChartLevelDto[];
    markers: ChartMarkerDto[];
    panes: {
        volume: Array<{ time: number; value: number; ratio?: number; signal?: string }>;
        orderFlow: Array<{ time: number; deltaRatio: number; cvdTrend: string }>;
        derivatives: Array<{ time: number; fundingRate: number; fundingRank: number; oiChange4h: number; oiChange24h: number; oiChange7d: number }>;
        marketFilters: Array<{ time: number; btcDominance: number; usdtDominance: number; btcDominanceChange4h: number; usdtDominanceChange4h: number }>;
    };
    updatedAt: string;
}

export interface SnapshotAnalyticsDto {
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

export type AlertSettingsDto = Omit<DashboardAlertSettings, 'updatedAt'> & {
    updatedAt: string;
};
