import type { AnalysisDetailDto, AnalysisResult } from '../types/analysis';

export function adaptAnalysisDetail(dto: AnalysisDetailDto): AnalysisResult {
  return {
    symbol: dto.symbol,
    timeframe: dto.timeframe,
    decision: dto.mainSetup.decision,
    score: dto.mainSetup.directionScore,
    confidence: Math.abs(dto.mainSetup.directionScore),
    tradeConfidence: dto.mainSetup.tradeConfidence,
    directionScore: dto.mainSetup.directionScore,
    setupQualityScore: dto.mainSetup.setupQualityScore,
    riskScore: dto.mainSetup.riskScore,
    primaryScenario: dto.mainSetup.primaryScenario,
    riskSide: dto.mainSetup.primaryScenario === 'SHORT' ? 'SHORT' : 'LONG',
    setupQuality: dto.mainSetup.setupQuality,
    setupReason: dto.mainSetup.mainReason,
    mainReason: dto.mainSetup.mainReason,
    currentAction: dto.mainSetup.currentAction,
    whyNotNow: dto.mainSetup.whyNotNow,
    aiSummary: dto.summary,
    marketRegime: 'UNCLEAR',
    marketState: dto.marketState,
    entry: {
      type: dto.mainSetup.decision === 'WAIT' ? 'NO_TRADE' : 'LIMIT_ZONE',
      currentPrice: dto.price.current
    },
    dynamicReferenceZone: dto.dynamicReferenceZone,
    actionableEntryZone: dto.actionableEntryZone,
    activationLevels: dto.activationLevels,
    riskManagement: dto.riskManagement,
    analysis: dto.context,
    categoryScores: dto.scoreBreakdown,
    reasoning: dto.reasoning,
    warnings: dto.warnings,
    nextConditions: dto.scenarios,
    bias: dto.mainSetup.bias,
    reasonForDecision: dto.mainSetup.mainReason,
    tacticalSetup: dto.tacticalSetup,
    createdAt: dto.price.updatedAt,
    strategyVersion: dto.strategyVersion
  };
}
