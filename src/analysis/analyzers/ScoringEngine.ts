import {
    AtrAnalysis,
    CategoryScore,
    Decision,
    EntryPlan,
    LevelsAnalysis,
    MarketContextAnalysis,
    MarketStructureAnalysis,
    DerivativesAnalysis,
    OrderFlowAnalysis,
    MarketRegime,
    MarketRegimeAnalysis,
    RetestAnalysis,
    RiskManagementPlan,
    SetupQuality,
    TriggerCandleAnalysis,
    TrendAnalysis,
    VolumeAnalysis
} from '../types';
import { clamp, roundToTick } from '../utils/math';

export type ScoringInput = {
    symbol: string;
    currentPrice: number;
    weeklyTrend: TrendAnalysis;
    dailyTrend: TrendAnalysis;
    h4Trend: TrendAnalysis;
    h1Trend: TrendAnalysis;
    h4Structure: MarketStructureAnalysis;
    h4Levels: LevelsAnalysis;
    h4Atr: AtrAnalysis;
    volume: VolumeAnalysis;
    btcDailyTrend: TrendAnalysis;
    btcH4Trend: TrendAnalysis;
    marketContext: MarketContextAnalysis;
    derivatives: DerivativesAnalysis;
    orderFlow: OrderFlowAnalysis;
    triggerCandle: TriggerCandleAnalysis;
    retest: RetestAnalysis;
    marketRegimeAnalysis: MarketRegimeAnalysis;
};

export type ScoringOutput = {
    decision: Decision;
    score: number;
    confidence: number;
    tradeConfidence: number | null;
    entry: EntryPlan;
    riskManagement: RiskManagementPlan;
    categoryScores: CategoryScore[];
    reasoning: string[];
    warnings: string[];
    nextConditions: string[];
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    directionScore: number;
    setupQualityScore: number;
    riskScore: number;
    setupQuality: SetupQuality;
    setupReason: string;
    mainReason: string;
    currentAction: string;
    whyNotNow: string[];
    marketRegime: MarketRegime;
    reasonForDecision: string;
};

export class ScoringEngine {
    public score(input: ScoringInput): ScoringOutput {
        const categories: CategoryScore[] = [];
        const isBtc = input.symbol === 'BTCUSDT';

        const htfScore = this.scoreHtf(input.weeklyTrend, input.dailyTrend);
        categories.push(htfScore);

        const structureScore = this.scoreStructure(input.h4Structure, input.h4Levels);
        categories.push(structureScore);

        categories.push({
            category: 'VOLUME_CONFIRMATION',
            score: input.volume.score,
            max: 10,
            explanation: `4H volume is ${input.volume.ratio.toFixed(2)}x 20-candle average.`
        });

        if (!isBtc) {
            categories.push(this.scoreBtc(input.btcDailyTrend, input.btcH4Trend));
            categories.push({
                category: 'BTC_DOMINANCE',
                score: input.marketContext.btcDominance.score,
                max: 10,
                explanation: `${input.marketContext.btcDominance.impactDescription}.`
            });
        }

        categories.push({
            category: 'USDT_DOMINANCE',
            score: input.marketContext.usdtDominance.score,
            max: 15,
            explanation: `${input.marketContext.usdtDominance.impactDescription}.`
        });

        categories.push({
            category: 'DERIVATIVES',
            score: input.derivatives.score,
            max: 20,
            explanation: `${input.derivatives.fundingInterpretation}. ${input.derivatives.positioningInterpretation}. ${input.derivatives.oiInterpretation}.`
        });

        categories.push({
            category: 'CVD_DELTA',
            score: input.orderFlow.score,
            max: 15,
            explanation: input.orderFlow.interpretation
        });

        categories.push({
            category: 'MARKET_REGIME',
            score: input.marketRegimeAnalysis.score,
            max: 10,
            explanation: input.marketRegimeAnalysis.summary
        });

        categories.push({
            category: 'TRIGGER_CANDLE',
            score: input.triggerCandle.score,
            max: 10,
            explanation: input.triggerCandle.summary
        });

        categories.push({
            category: 'RETEST',
            score: input.retest.score,
            max: 10,
            explanation: input.retest.summary
        });

        const directionRawScore = categories.reduce((sum, item) => sum + item.score, 0);
        const uncappedDirectionScore = Math.round(clamp((directionRawScore / 75) * 100, -100, 100));
        const directionScore = this.applyDirectionCaps(uncappedDirectionScore, input);
        const direction: 'LONG' | 'SHORT' = directionScore >= 0 ? 'LONG' : 'SHORT';
        const risk = this.buildRiskPlan(direction, input);
        const riskScore = this.calculateRiskScore(risk.riskManagement.riskReward);
        const setupQualityScore = this.calculateSetupQualityScore(direction, input, risk.riskManagement);
        const setupQuality = this.getSetupQuality(setupQualityScore);
        const setupReason = this.buildSetupReason(direction, input, risk.riskManagement);
        const marketRegime = input.marketRegimeAnalysis.regime;

        categories.push({
            category: 'RISK_REWARD',
            score: risk.riskManagement.riskReward && risk.riskManagement.riskReward >= 2 ? 18 : risk.riskManagement.riskReward && risk.riskManagement.riskReward >= 1.8 ? 10 : -20,
            max: 20,
            explanation: risk.riskManagement.riskReward
                ? `Estimated R/R is ${risk.riskManagement.riskReward.toFixed(2)}.`
                : risk.riskManagement.reason || 'Risk/reward cannot be calculated.'
        });

        const volatilityScore = this.scoreVolatility(input.h4Trend, input.h4Atr);
        categories.push(volatilityScore);

        const score = Math.round(clamp(directionScore * (setupQualityScore / 100), -100, 100));
        const warnings = [...risk.warnings];
        const reasoning = categories
            .filter(item => Math.abs(item.score) >= 5)
            .map(item => item.explanation);

        if (input.h4Levels.premiumDiscount === 'PREMIUM' && direction === 'LONG') {
            warnings.push('Long setup is in premium zone; chasing risk is elevated.');
        }
        if (input.h4Levels.premiumDiscount === 'DISCOUNT' && direction === 'SHORT') {
            warnings.push('Short setup is in discount zone; chasing risk is elevated.');
        }
        if (input.marketContext.usdtDominance.score < -10 && direction === 'LONG') {
            warnings.push('USDT dominance is risk-off and conflicts with long scenario.');
        }
        if (input.marketContext.usdtDominance.score > 8 && direction === 'SHORT') {
            warnings.push('USDT dominance is risk-on and weakens short scenario.');
        }
        if (direction === 'LONG' && input.orderFlow.divergence === 'BEARISH') {
            warnings.push('Bearish CVD divergence weakens breakout/long scenario.');
        }
        if (direction === 'SHORT' && input.orderFlow.divergence === 'BULLISH') {
            warnings.push('Bullish CVD divergence weakens breakdown/short scenario.');
        }
        if (input.retest.state === 'FAILED') {
            warnings.push(`Retest failed: ${input.retest.summary}`);
        }
        if (input.triggerCandle.quality === 'REJECTION' && !((direction === 'LONG' && input.triggerCandle.direction === 'BULLISH') || (direction === 'SHORT' && input.triggerCandle.direction === 'BEARISH'))) {
            warnings.push(`Trigger candle rejects the active direction: ${input.triggerCandle.summary}`);
        } else if (input.triggerCandle.quality === 'REJECTION') {
            warnings.push(`Trigger candle supports direction, but entry still needs volume/RR confirmation: ${input.triggerCandle.summary}`);
        }
        if (risk.riskManagement.riskReward && risk.riskManagement.riskReward < 1.0) {
            warnings.push(`Risk/reward is ${risk.riskManagement.riskReward.toFixed(2)}, far below required minimum 1.8. No trade even if direction is favorable.`);
        } else if (risk.riskManagement.riskReward && risk.riskManagement.riskReward <= 1.9) {
            warnings.push(`Risk/reward is ${risk.riskManagement.riskReward.toFixed(2)}, only near required minimum 1.8; entry quality is not ideal.`);
        }

        let decision: Decision = 'WAIT';
        if (directionScore >= 65 && setupQualityScore >= 65 && riskScore >= 65 && direction === 'LONG') decision = 'LONG';
        if (directionScore <= -65 && setupQualityScore >= 65 && riskScore >= 65 && direction === 'SHORT') decision = 'SHORT';

        if (riskScore < 65) {
            decision = 'WAIT';
            warnings.push('Decision forced to WAIT because risk/reward is below 1.8.');
        }

        if (Math.abs(directionScore) < 65 || setupQualityScore < 65) {
            decision = 'WAIT';
            if (directionScore >= 15) {
                warnings.push(`Bullish direction, but direction/setup thresholds are not both satisfied (${directionScore}/100 direction, ${setupQualityScore}/100 setup).`);
            } else if (directionScore <= -15) {
                warnings.push(`Bearish direction, but direction/setup thresholds are not both satisfied (${directionScore}/100 direction, ${setupQualityScore}/100 setup).`);
            }
        }

        const conflictPenalty = warnings.length >= 3 ? 15 : warnings.length >= 2 ? 10 : warnings.length === 1 ? 5 : 0;
        const confidence = Math.round(clamp(Math.min(Math.abs(directionScore), setupQualityScore, riskScore) - conflictPenalty, 0, 100));
        const tradeConfidence = decision === 'WAIT' ? null : confidence;
        const nextConditions = this.buildNextConditions(direction, score, input, risk.riskManagement);
        const reasonForDecision = this.buildReasonForDecision(decision, direction, directionScore, setupQuality, setupQualityScore, riskScore, risk.riskManagement.riskReward);
        const whyNotNow = this.buildWhyNotNow(direction, input, risk.riskManagement);
        const mainReason = this.buildMainReason(direction, input, risk.riskManagement);
        const currentAction = decision === 'WAIT'
            ? 'No trade. Wait for pullback with acceptable R/R or breakout activation followed by retest confirmation.'
            : `${decision} setup is active; use the trade plan and invalidation rules.`;

        return {
            decision,
            score,
            confidence,
            tradeConfidence,
            entry: risk.entry,
            riskManagement: risk.riskManagement,
            categoryScores: categories,
            reasoning,
            warnings,
            nextConditions,
            bias: directionScore > 15 ? 'BULLISH' : directionScore < -15 ? 'BEARISH' : 'NEUTRAL',
            directionScore,
            setupQualityScore,
            riskScore,
            setupQuality,
            setupReason,
            mainReason,
            currentAction,
            whyNotNow,
            marketRegime,
            reasonForDecision
        };
    }

    private scoreHtf(weekly: TrendAnalysis, daily: TrendAnalysis): CategoryScore {
        let score = 0;
        if (weekly.trend === 'UPTREND') score += 8;
        if (weekly.trend === 'DOWNTREND') score -= 8;
        if (daily.trend === 'UPTREND') score += 12;
        if (daily.trend === 'DOWNTREND') score -= 12;

        return {
            category: 'HTF_CONTEXT',
            score,
            max: 20,
            explanation: `HTF context: weekly ${weekly.trend}, daily ${daily.trend}.`
        };
    }

    private scoreStructure(structure: MarketStructureAnalysis, levels: LevelsAnalysis): CategoryScore {
        let score = 0;
        if (structure.structure === 'BULLISH_STRUCTURE') score += 18;
        if (structure.structure === 'BEARISH_STRUCTURE') score -= 18;
        if (structure.bos === 'BULLISH') score += 7;
        if (structure.bos === 'BEARISH') score -= 7;
        if (levels.premiumDiscount === 'DISCOUNT') score += 3;
        if (levels.premiumDiscount === 'PREMIUM') score -= 3;

        return {
            category: 'MARKET_STRUCTURE_4H',
            score: clamp(score, -25, 25),
            max: 25,
            explanation: `4H structure is ${structure.structure}, BOS ${structure.bos}, zone ${levels.premiumDiscount}.`
        };
    }

    private scoreBtc(daily: TrendAnalysis, h4: TrendAnalysis): CategoryScore {
        let score = 0;
        if (daily.trend === 'UPTREND') score += 8;
        if (daily.trend === 'DOWNTREND') score -= 8;
        if (h4.trend === 'UPTREND') score += 7;
        if (h4.trend === 'DOWNTREND') score -= 7;

        return {
            category: 'BTC_CONTEXT',
            score,
            max: 15,
            explanation: `BTC filter: daily ${daily.trend}, 4H ${h4.trend}.`
        };
    }

    private scoreVolatility(h4Trend: TrendAnalysis, atr: AtrAnalysis): CategoryScore {
        const extended = Math.abs(h4Trend.distanceFromSma20Atr);
        let score = 0;
        if (extended > 2.5) score = -8;
        else if (atr.atrPercent > 0 && atr.atrPercent < 6) score = 5;

        return {
            category: 'VOLATILITY',
            score,
            max: 10,
            explanation: `4H ATR is ${atr.atrPercent.toFixed(2)}%, price is ${extended.toFixed(2)} ATR from SMA20.`
        };
    }

    private calculateRiskScore(riskReward?: number): number {
        if (!riskReward || riskReward <= 0) return 0;
        if (riskReward >= 2.5) return 100;
        if (riskReward >= 2.0) return 80;
        if (riskReward >= 1.8) return 65;
        if (riskReward >= 1.2) return 40;
        if (riskReward >= 0.8) return 20;
        return 5;
    }

    private calculateSetupQualityScore(direction: 'LONG' | 'SHORT', input: ScoringInput, risk: RiskManagementPlan): number {
        let score = 50;
        const rr = risk.riskReward || 0;
        const atrExtension = Math.abs(input.h4Trend.distanceFromSma20Atr);

        if (rr >= 2.5) score += 25;
        else if (rr >= 2.0) score += 18;
        else if (rr >= 1.8) score += 10;
        else if (rr >= 1.2) score -= 10;
        else if (rr >= 0.8) score -= 22;
        else score -= 35;

        if (direction === 'LONG') {
            if (input.h4Levels.premiumDiscount === 'DISCOUNT') score += 15;
            if (input.h4Levels.premiumDiscount === 'EQUILIBRIUM') score += 3;
            if (input.h4Levels.premiumDiscount === 'PREMIUM') score -= 20;
            if (input.h4Levels.nearestResistance && input.h4Levels.nearestResistance.price - input.currentPrice < input.h4Atr.atr14 * 0.8) score -= 15;
        } else {
            if (input.h4Levels.premiumDiscount === 'PREMIUM') score += 15;
            if (input.h4Levels.premiumDiscount === 'EQUILIBRIUM') score += 3;
            if (input.h4Levels.premiumDiscount === 'DISCOUNT') score -= 20;
            if (input.h4Levels.nearestSupport && input.currentPrice - input.h4Levels.nearestSupport.price < input.h4Atr.atr14 * 0.8) score -= 15;
        }

        if (atrExtension > 2.5) score -= 20;
        else if (atrExtension > 1.5) score -= 10;
        else if (atrExtension < 0.8) score += 8;

        if (risk.tpBlockedByLevel) score -= 20;
        if (input.retest.state === 'CONFIRMED') score += 10;
        if (input.retest.state === 'FAILED') score -= 20;
        if (input.retest.state === 'PENDING') score -= 5;
        if (input.triggerCandle.quality === 'STRONG') score += 8;
        if (input.triggerCandle.quality === 'WEAK') score -= 5;
        if (input.triggerCandle.quality === 'REJECTION') {
            if ((direction === 'LONG' && input.triggerCandle.direction === 'BULLISH') || (direction === 'SHORT' && input.triggerCandle.direction === 'BEARISH')) score += 3;
            else score -= 12;
        }

        return Math.round(clamp(score, 0, 100));
    }

    private getSetupQuality(score: number): SetupQuality {
        if (score >= 75) return 'GOOD';
        if (score >= 60) return 'ACCEPTABLE';
        if (score >= 35) return 'POOR';
        return 'CHASE';
    }

    private buildSetupReason(direction: 'LONG' | 'SHORT', input: ScoringInput, risk: RiskManagementPlan): string {
        const reasons: string[] = [];
        const rr = risk.riskReward;
        const atrExtension = Math.abs(input.h4Trend.distanceFromSma20Atr);

        if (direction === 'LONG' && input.h4Levels.premiumDiscount === 'PREMIUM') reasons.push('price is in premium zone');
        if (direction === 'LONG' && input.h4Levels.premiumDiscount === 'DISCOUNT') reasons.push('price is in discount zone');
        if (direction === 'SHORT' && input.h4Levels.premiumDiscount === 'DISCOUNT') reasons.push('price is in discount zone');
        if (direction === 'SHORT' && input.h4Levels.premiumDiscount === 'PREMIUM') reasons.push('price is in premium zone');

        if (atrExtension >= 1.5) reasons.push(`extended ${atrExtension.toFixed(2)} ATR from SMA20`);
        if (atrExtension < 0.8) reasons.push(`not extended from SMA20 (${atrExtension.toFixed(2)} ATR)`);
        if (risk.tpBlockedByLevel && risk.nearestBlockingLevel) reasons.push(`nearest ${direction === 'LONG' ? 'resistance' : 'support'} at ${risk.nearestBlockingLevel} blocks TP1 path`);
        if (risk.missedRetestEntry) reasons.push('confirmed retest entry is already missed');
        if (input.triggerCandle.quality === 'WEAK') reasons.push('trigger candle is weak');
        if (rr) reasons.push(`R/R is ${rr.toFixed(2)} versus required 1.8`);

        if (reasons.length === 0) return 'No major setup-quality constraints detected.';
        return reasons.join(', ') + '.';
    }

    private buildReasonForDecision(
        decision: Decision,
        direction: 'LONG' | 'SHORT',
        directionScore: number,
        setupQuality: SetupQuality,
        setupQualityScore: number,
        riskScore: number,
        riskReward?: number
    ): string {
        if (decision !== 'WAIT') {
            return `${decision} because direction score is ${directionScore}/100, setup quality is ${setupQuality} ${setupQualityScore}/100, and risk score is ${riskScore}/100.`;
        }

        const biasText = direction === 'LONG' ? 'bullish' : 'bearish';
        if (!riskReward || riskReward < 1.8) {
            return `Directional bias is ${biasText} (${directionScore}/100), but trade setup is invalid: R/R is ${riskReward?.toFixed(2) || 'n/a'} below required 1.8 and setup quality is ${setupQuality} ${setupQualityScore}/100.`;
        }
        if (setupQualityScore < 65) {
            return `Directional bias is ${biasText} (${directionScore}/100), but setup quality is ${setupQuality} ${setupQualityScore}/100. Wait for better entry or confirmation.`;
        }
        return `WAIT because directional score ${directionScore}/100 is below the required threshold.`;
    }

    private buildRiskPlan(direction: 'LONG' | 'SHORT', input: ScoringInput): { entry: EntryPlan; riskManagement: RiskManagementPlan; warnings: string[] } {
        const atr = input.h4Atr.atr14;
        const current = input.currentPrice;
        const warnings: string[] = [];

        if (!atr || atr <= 0) {
            return {
                entry: { type: 'NO_TRADE', currentPrice: current },
                riskManagement: { takeProfit: [], reason: 'ATR is unavailable.' },
                warnings: ['ATR unavailable, cannot build risk plan.']
            };
        }

        if (direction === 'LONG') {
            const support = input.h4Levels.nearestSupport?.price;
            const entryTo = roundToTick(current - atr * 0.15);
            const entryFrom = roundToTick(Math.max(support || current - atr * 0.7, current - atr * 0.7));
            const stopLoss = roundToTick((support || current - atr) - atr * 0.35);
            const entryMid = (entryFrom + entryTo) / 2;
            const risk = entryMid - stopLoss;

            if (risk <= 0) {
                return {
                    entry: { type: 'NO_TRADE', currentPrice: current },
                    riskManagement: { takeProfit: [], reason: 'Long stop is above entry zone.' },
                    warnings: ['Invalid long risk geometry.']
                };
            }

            const takeProfit = [1.8, 2.5, 3.5].map(rr => roundToTick(entryMid + risk * rr));
            const nearestResistance = input.h4Levels.nearestResistance?.price;
            const tpBlockedByLevel = Boolean(nearestResistance && nearestResistance > entryMid && nearestResistance < takeProfit[0]);
            if (tpBlockedByLevel && nearestResistance) {
                takeProfit[0] = roundToTick(Math.max(entryMid + risk * 0.5, nearestResistance - atr * 0.15));
                takeProfit.sort((a, b) => a - b);
            }
            const effectiveTarget = takeProfit[0];
            const riskReward = (effectiveTarget - entryMid) / risk;
            const nearestBlockingLevelDistancePct = tpBlockedByLevel && nearestResistance
                ? ((nearestResistance - current) / current) * 100
                : undefined;
            const pathToTpComment = tpBlockedByLevel && nearestResistance
                ? `TP1 adjusted before blocking resistance ${nearestResistance}; clean path is limited.`
                : 'Path to TP1 is not blocked by nearest resistance.';

            if (tpBlockedByLevel) {
                warnings.push(pathToTpComment);
            }
            const requiredEntryForMinRr = this.calculateRequiredLongEntry(effectiveTarget, stopLoss, 1.8);
            const missedRetestEntry = input.retest.state === 'CONFIRMED' && current > entryTo;

            return {
                entry: { type: 'LIMIT_ZONE', from: entryFrom, to: entryTo, currentPrice: current },
                riskManagement: {
                    stopLoss,
                    takeProfit,
                    riskReward: Number(riskReward.toFixed(2)),
                    invalidation: `4H candle close below ${stopLoss}`,
                    tpBlockedByLevel,
                    nearestBlockingLevel: tpBlockedByLevel ? nearestResistance : undefined,
                    nearestBlockingLevelDistancePct: nearestBlockingLevelDistancePct !== undefined ? Number(nearestBlockingLevelDistancePct.toFixed(2)) : undefined,
                    pathToTpScore: tpBlockedByLevel ? 0 : 80,
                    pathToTpComment,
                    missedRetestEntry,
                    currentEntryStatus: missedRetestEntry ? 'MISSED_RETEST' : current > entryTo ? 'TOO_LATE' : 'VALID',
                    retestLevel: input.retest.level,
                    retestEntryComment: missedRetestEntry ? `Retest was confirmed near ${input.retest.level}, but current price moved above the retest/reference zone.` : undefined,
                    requiredEntryForMinRr: roundToTick(requiredEntryForMinRr),
                    requiredEntryComment: `For R/R >= 1.8 with current stop/target geometry, long entry needs to be at or below ${roundToTick(requiredEntryForMinRr)} or resistance must break and create a new clean TP path.`,
                    scenarioInvalidation: `Bullish scenario invalidates on 4H close below ${stopLoss}.`,
                    pullbackTradeStop: support ? `Pullback trade stop should be below local reaction low/support near ${support}, not blindly at scenario invalidation.` : 'Pullback trade stop should be below the local reaction low.',
                    breakoutRetestTradeStop: nearestResistance ? `Breakout retest stop should be below reclaimed/retested level ${nearestResistance} after it holds as support.` : 'Breakout retest stop should be below the retested breakout level.'
                },
                warnings
            };
        }

        const resistance = input.h4Levels.nearestResistance?.price;
        const entryFrom = roundToTick(current + atr * 0.15);
        const entryTo = roundToTick(Math.min(resistance || current + atr * 0.7, current + atr * 0.7));
        const stopLoss = roundToTick((resistance || current + atr) + atr * 0.35);
        const entryMid = (entryFrom + entryTo) / 2;
        const risk = stopLoss - entryMid;

        if (risk <= 0) {
            return {
                entry: { type: 'NO_TRADE', currentPrice: current },
                riskManagement: { takeProfit: [], reason: 'Short stop is below entry zone.' },
                warnings: ['Invalid short risk geometry.']
            };
        }

        const takeProfit = [1.8, 2.5, 3.5].map(rr => roundToTick(entryMid - risk * rr));
        const nearestSupport = input.h4Levels.nearestSupport?.price;
        const tpBlockedByLevel = Boolean(nearestSupport && nearestSupport < entryMid && nearestSupport > takeProfit[0]);
        if (tpBlockedByLevel && nearestSupport) {
            takeProfit[0] = roundToTick(Math.min(entryMid - risk * 0.5, nearestSupport + atr * 0.15));
            takeProfit.sort((a, b) => b - a);
        }
        const effectiveTarget = takeProfit[0];
        const riskReward = (entryMid - effectiveTarget) / risk;
        const nearestBlockingLevelDistancePct = tpBlockedByLevel && nearestSupport
            ? ((current - nearestSupport) / current) * 100
            : undefined;
        const pathToTpComment = tpBlockedByLevel && nearestSupport
            ? `TP1 adjusted before blocking support ${nearestSupport}; clean path is limited.`
            : 'Path to TP1 is not blocked by nearest support.';

        if (tpBlockedByLevel) {
            warnings.push(pathToTpComment);
        }
        const requiredEntryForMinRr = this.calculateRequiredShortEntry(effectiveTarget, stopLoss, 1.8);
        const missedRetestEntry = input.retest.state === 'CONFIRMED' && current < entryFrom;

        return {
            entry: { type: 'LIMIT_ZONE', from: entryFrom, to: entryTo, currentPrice: current },
            riskManagement: {
                stopLoss,
                takeProfit,
                riskReward: Number(riskReward.toFixed(2)),
                invalidation: `4H candle close above ${stopLoss}`,
                tpBlockedByLevel,
                nearestBlockingLevel: tpBlockedByLevel ? nearestSupport : undefined,
                nearestBlockingLevelDistancePct: nearestBlockingLevelDistancePct !== undefined ? Number(nearestBlockingLevelDistancePct.toFixed(2)) : undefined,
                pathToTpScore: tpBlockedByLevel ? 0 : 80,
                pathToTpComment,
                missedRetestEntry,
                currentEntryStatus: missedRetestEntry ? 'MISSED_RETEST' : current < entryFrom ? 'TOO_LATE' : 'VALID',
                retestLevel: input.retest.level,
                retestEntryComment: missedRetestEntry ? `Retest was confirmed near ${input.retest.level}, but current price moved below the retest/reference zone.` : undefined,
                requiredEntryForMinRr: roundToTick(requiredEntryForMinRr),
                requiredEntryComment: `For R/R >= 1.8 with current stop/target geometry, short entry needs to be at or above ${roundToTick(requiredEntryForMinRr)} or support must break and create a new clean TP path.`,
                scenarioInvalidation: `Bearish scenario invalidates on 4H close above ${stopLoss}.`,
                pullbackTradeStop: resistance ? `Pullback trade stop should be above local reaction high/resistance near ${resistance}, not blindly at scenario invalidation.` : 'Pullback trade stop should be above the local reaction high.',
                breakoutRetestTradeStop: nearestSupport ? `Breakdown retest stop should be above reclaimed/retested level ${nearestSupport} after it holds as resistance.` : 'Breakdown retest stop should be above the retested breakdown level.'
            },
            warnings
        };
    }

    private buildNextConditions(direction: 'LONG' | 'SHORT', score: number, input: ScoringInput, risk: RiskManagementPlan): string[] {
        const conditions: string[] = [];
        const volumeTrigger = '4H volume > 1.5x average';

        if (direction === 'LONG') {
            const resistance = input.h4Levels.nearestResistance?.price;
            const support = input.h4Levels.nearestSupport?.price;
            const referenceZone = risk && risk.riskReward ? `${input.currentPrice}` : 'current area';
            if (score < 65) {
                conditions.push(`Breakout LONG activation: Step 1 close above ${resistance || 'nearest resistance'} with ${volumeTrigger}, rising CVD, and USDT.D not breaking upward. This is not an entry yet.`);
                conditions.push(`Breakout LONG entry: Step 2 wait for retest of ${resistance || 'breakout level'} as support; Step 3 enter only if R/R after retest is >= 1.8.`);
            }
            if (support) {
                conditions.push(risk.requiredEntryForMinRr
                    ? `Pullback LONG: preferred zone near ${support}-${risk.requiredEntryForMinRr}, where current stop/target geometry can provide R/R >= 1.8. Old retest/reference zone is valid again only if new local stop/target structure forms.`
                    : `Pullback LONG: better setup near ${input.h4Levels.nearestSupport ? support : referenceZone}, with bullish 1H/4H reaction and R/R >= 1.8.`);
            }
            if (risk.requiredEntryComment) conditions.push(risk.requiredEntryComment);
            return conditions.slice(0, 4);
        }

        const support = input.h4Levels.nearestSupport?.price;
        const resistance = input.h4Levels.nearestResistance?.price;
        const referenceZone = risk && risk.riskReward ? `${input.currentPrice}` : 'current area';
        if (score > -65) {
            conditions.push(`Breakdown SHORT activation: Step 1 close below ${support || 'nearest support'} with ${volumeTrigger}, falling CVD, and USDT.D turning risk-off. This is not an entry yet.`);
            conditions.push(`Breakdown SHORT entry: Step 2 wait for retest of ${support || 'breakdown level'} as resistance; Step 3 enter only if R/R after retest is >= 1.8.`);
        }
        if (resistance) {
            conditions.push(risk.requiredEntryForMinRr
                ? `Pullback SHORT: preferred zone near ${risk.requiredEntryForMinRr}-${resistance}, where current stop/target geometry can provide R/R >= 1.8. Old retest/reference zone is valid again only if new local stop/target structure forms.`
                : `Pullback SHORT: better setup near ${input.h4Levels.nearestResistance ? resistance : referenceZone}, with bearish 1H/4H reaction and R/R >= 1.8.`);
        }
        if (risk.requiredEntryComment) conditions.push(risk.requiredEntryComment);
        return conditions.slice(0, 4);
    }

    private applyDirectionCaps(score: number, input: ScoringInput): number {
        let capped = score;
        const direction: 'LONG' | 'SHORT' = score >= 0 ? 'LONG' : 'SHORT';
        const nearResistance = Boolean(input.h4Levels.nearestResistance && input.h4Levels.nearestResistance.price - input.currentPrice < input.h4Atr.atr14 * 0.8);
        const nearSupport = Boolean(input.h4Levels.nearestSupport && input.currentPrice - input.h4Levels.nearestSupport.price < input.h4Atr.atr14 * 0.8);

        if (input.weeklyTrend.trend === 'RANGE' && input.marketContext.usdtDominance.signalImpact === 'NEUTRAL') {
            capped = direction === 'LONG' ? Math.min(capped, 82) : Math.max(capped, -82);
        }
        if (direction === 'LONG' && nearResistance && input.volume.ratio < 1.2) {
            capped = Math.min(capped, 78);
        }
        if (direction === 'SHORT' && nearSupport && input.volume.ratio < 1.2) {
            capped = Math.max(capped, -78);
        }
        if (input.derivatives.priceOiDivergence === 'LEVERAGE_BUILDUP') {
            capped = direction === 'LONG' ? Math.min(capped, 80) : Math.max(capped, -80);
        }

        return capped;
    }

    private buildWhyNotNow(direction: 'LONG' | 'SHORT', input: ScoringInput, risk: RiskManagementPlan): string[] {
        const reasons: string[] = [];
        const rr = risk.riskReward || 0;
        if (rr < 1.8) reasons.push(`R/R is ${rr.toFixed(2)}, required minimum is 1.8.`);
        if (direction === 'LONG' && input.h4Levels.premiumDiscount === 'PREMIUM') reasons.push('Price is in premium zone.');
        if (direction === 'SHORT' && input.h4Levels.premiumDiscount === 'DISCOUNT') reasons.push('Price is in discount zone.');
        const atrExtension = Math.abs(input.h4Trend.distanceFromSma20Atr);
        if (atrExtension >= 1.5) reasons.push(`Price is extended ${atrExtension.toFixed(2)} ATR from SMA20.`);
        if (risk.nearestBlockingLevel) reasons.push(`Nearest ${direction === 'LONG' ? 'resistance' : 'support'} ${risk.nearestBlockingLevel} blocks clean TP path.`);
        if (input.volume.ratio < 1.2) reasons.push(`Volume is only ${input.volume.ratio.toFixed(2)}x average, no breakout volume confirmation.`);
        if (risk.missedRetestEntry) reasons.push('Retest was confirmed, but the current entry is already missed.');
        return reasons;
    }

    private buildMainReason(direction: 'LONG' | 'SHORT', input: ScoringInput, risk: RiskManagementPlan): string {
        const side = direction === 'LONG' ? 'long' : 'short';
        if (risk.missedRetestEntry) {
            return `${direction === 'LONG' ? 'Bullish' : 'Bearish'} direction is valid, but current ${side} entry is late. Retest was confirmed, then price moved away from the retest zone; current R/R is ${risk.riskReward?.toFixed(2) || 'n/a'} vs required 1.8.`;
        }
        return `${direction === 'LONG' ? 'Bullish' : 'Bearish'} direction is valid only as bias; current ${side} setup needs acceptable R/R and confirmation before entry.`;
    }

    private calculateRequiredLongEntry(target: number, stop: number, requiredRr: number): number {
        return (target + requiredRr * stop) / (1 + requiredRr);
    }

    private calculateRequiredShortEntry(target: number, stop: number, requiredRr: number): number {
        return (target + requiredRr * stop) / (1 + requiredRr);
    }
}
