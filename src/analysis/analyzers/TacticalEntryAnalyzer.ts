import {
    AtrAnalysis,
    Decision,
    DominanceAnalysis,
    EntryPlan,
    LevelsAnalysis,
    MarketStructureAnalysis,
    OrderFlowAnalysis,
    PrimaryScenario,
    RiskManagementPlan,
    TacticalSetup,
    TriggerCandleAnalysis,
    TrendAnalysis
} from '../types';
import { clamp, roundToTick } from '../utils/math';

type TacticalDirection = Exclude<PrimaryScenario, 'NEUTRAL'>;

export type TacticalEntryInput = {
    symbol: string;
    currentPrice: number;
    mainDecision: Decision;
    primaryScenario: PrimaryScenario;
    directionScore: number;
    entry: EntryPlan;
    riskManagement: RiskManagementPlan;
    h1Trend: TrendAnalysis;
    h1Structure: MarketStructureAnalysis;
    h1Levels: LevelsAnalysis;
    h1Atr: AtrAnalysis;
    h1TriggerCandle: TriggerCandleAnalysis;
    h1OrderFlow: OrderFlowAnalysis;
    usdtDominance: DominanceAnalysis;
    h4Invalidation?: string;
    actionableEntryZone?: TacticalEntryInputActionableZone;
};

type TacticalEntryInputActionableZone = {
    from: number;
    to: number;
    side: 'LONG' | 'SHORT';
    status: string;
    source: string;
};

export class TacticalEntryAnalyzer {
    public analyze(input: TacticalEntryInput): TacticalSetup {
        const disabled = this.getDisabledReason(input);
        if (disabled) {
            return this.buildDisabled(disabled);
        }

        const side = input.primaryScenario as TacticalDirection;
        const zone = this.buildZone(side, input);
        if (!zone) {
            return this.buildDisabled('Tactical zone cannot be calculated from current 4H risk geometry.');
        }

        const invalidated = this.isInvalidated(side, input);
        const stop = this.buildStop(side, input, zone);
        const rr = stop ? this.calculateRiskReward(side, input.currentPrice, zone, stop.price, input) : undefined;
        const requiredEntryForMinRr = stop ? this.calculateRequiredEntryForMinRr(side, stop.price, input) : undefined;
        const zoneStatus = this.getZoneStatus(side, zone, requiredEntryForMinRr, rr);
        const confirmations = this.buildConfirmations(side, input, zone, rr, stop?.price, zoneStatus);
        const waitingFor = this.buildWaitingFor(side, confirmations, requiredEntryForMinRr, zoneStatus);
        const invalidation = this.buildInvalidation(side, input, stop?.price, false);

        if (invalidated) {
            return {
                timeframe: '1h',
                status: 'INVALIDATED',
                side,
                reason: 'Tactical scenario invalidated by main 4H invalidation or broken local structure.',
                zone,
                rr,
                requiredEntryForMinRr,
                zoneStatus,
                stop,
                confirmations,
                waitingFor,
                invalidation,
                createdAt: new Date().toISOString()
            };
        }

        const status = this.getStatus(confirmations);
        const finalInvalidation = this.buildInvalidation(side, input, stop?.price, status === 'CONFIRMED');
        return {
            timeframe: '1h',
            status,
            side,
            reason: this.buildReason(status, side, input, rr),
            zone,
            rr,
            requiredEntryForMinRr,
            zoneStatus,
            stop,
            confirmations,
            waitingFor,
            invalidation: finalInvalidation,
            createdAt: new Date().toISOString()
        };
    }

    private getDisabledReason(input: TacticalEntryInput): string | undefined {
        if (input.mainDecision !== 'WAIT') return 'Main 4H setup is already active; tactical layer is not needed.';
        if (input.primaryScenario === 'NEUTRAL') return '4H directional bias is neutral.';
        if (Math.abs(input.directionScore) < 50) return '4H directional bias is too weak for tactical entry.';
        if (!this.waitReasonIsEntryTimingOrRr(input)) return 'WAIT reason is not entry timing/R/R related.';

        if (input.primaryScenario === 'LONG') {
            if (input.usdtDominance.signalImpact === 'RISK_OFF' && input.usdtDominance.score <= -12) {
                return 'USDT.D shows hard risk-off conflict against tactical long.';
            }
            if (input.h1OrderFlow.cvdTrend === 'DOWN' && input.h1OrderFlow.divergence === 'BEARISH') {
                return '1H CVD is against tactical long.';
            }
        }

        if (input.primaryScenario === 'SHORT') {
            if (input.usdtDominance.signalImpact === 'RISK_ON' && input.usdtDominance.score >= 10) {
                return 'USDT.D shows hard risk-on conflict against tactical short.';
            }
            if (input.h1OrderFlow.cvdTrend === 'UP' && input.h1OrderFlow.divergence === 'BULLISH') {
                return '1H CVD is against tactical short.';
            }
        }

        return undefined;
    }

    private waitReasonIsEntryTimingOrRr(input: TacticalEntryInput): boolean {
        const risk = input.riskManagement;
        return Boolean(
            risk.riskReward && risk.riskReward < 1.8 ||
            risk.currentEntryStatus === 'MISSED_RETEST' ||
            risk.currentEntryStatus === 'TOO_LATE' ||
            risk.currentEntryStatus === 'WAITING_RETEST' ||
            risk.missedRetestEntry ||
            risk.nearestBlockingLevel
        );
    }

    private buildZone(side: TacticalDirection, input: TacticalEntryInput): TacticalSetup['zone'] | undefined {
        const atr = input.h1Atr.atr14;
        const required = input.riskManagement.requiredEntryForMinRr;
        if (!atr || atr <= 0) return undefined;
        if (input.actionableEntryZone && input.actionableEntryZone.side === side) {
            return {
                from: roundToTick(Math.min(input.actionableEntryZone.from, input.actionableEntryZone.to)),
                to: roundToTick(Math.max(input.actionableEntryZone.from, input.actionableEntryZone.to)),
                source: side === 'LONG' ? 'SUPPORT_AREA' : 'RESISTANCE_AREA'
            };
        }
        if (!required) return undefined;

        if (side === 'LONG') {
            const support = input.h1Levels.nearestSupport?.price;
            const zoneHigh = required;
            const zoneLow = support && support < zoneHigh
                ? Math.max(support, zoneHigh - atr * 0.8)
                : zoneHigh - atr * 0.55;
            return {
                from: roundToTick(Math.min(zoneLow, zoneHigh)),
                to: roundToTick(Math.max(zoneLow, zoneHigh)),
                source: 'REQUIRED_RR_ENTRY'
            };
        }

        const resistance = input.h1Levels.nearestResistance?.price;
        const zoneLow = required;
        const zoneHigh = resistance && resistance > zoneLow
            ? Math.min(resistance, zoneLow + atr * 0.8)
            : zoneLow + atr * 0.55;
        return {
            from: roundToTick(Math.min(zoneLow, zoneHigh)),
            to: roundToTick(Math.max(zoneLow, zoneHigh)),
            source: 'REQUIRED_RR_ENTRY'
        };
    }

    private buildStop(side: TacticalDirection, input: TacticalEntryInput, zone: NonNullable<TacticalSetup['zone']>): TacticalSetup['stop'] | undefined {
        const atr = input.h1Atr.atr14;
        if (!atr || atr <= 0) return undefined;
        const zoneLow = Math.min(zone.from, zone.to);
        const zoneHigh = Math.max(zone.from, zone.to);

        if (side === 'LONG') {
            const support = input.h1Levels.nearestSupport?.price;
            const localLow = support && support < zoneHigh ? support : zoneLow;
            return {
                price: roundToTick(localLow - atr * 0.25),
                source: support ? 'LOCAL_1H_LOW' : 'REACTION_LOW'
            };
        }

        const resistance = input.h1Levels.nearestResistance?.price;
        const localHigh = resistance && resistance > zoneLow ? resistance : zoneHigh;
        return {
            price: roundToTick(localHigh + atr * 0.25),
            source: resistance ? 'LOCAL_1H_HIGH' : 'REACTION_HIGH'
        };
    }

    private calculateRiskReward(side: TacticalDirection, currentPrice: number, zone: NonNullable<TacticalSetup['zone']>, stop: number, input: TacticalEntryInput): number | undefined {
        const zoneLow = Math.min(zone.from, zone.to);
        const zoneHigh = Math.max(zone.from, zone.to);
        const inZone = this.isInZone(side, currentPrice, zone, input.h1Atr.atr14);
        const entry = side === 'LONG'
            ? inZone ? currentPrice : zoneHigh
            : inZone ? currentPrice : zoneLow;
        const target = input.riskManagement.nearestBlockingLevel || (side === 'LONG'
            ? input.h1Levels.nearestResistance?.price
            : input.h1Levels.nearestSupport?.price);
        if (!target) return undefined;

        const risk = side === 'LONG' ? entry - stop : stop - entry;
        const reward = side === 'LONG' ? target - entry : entry - target;
        if (risk <= 0 || reward <= 0) return undefined;
        return Number(clamp(reward / risk, 0, 10).toFixed(2));
    }

    private buildConfirmations(side: TacticalDirection, input: TacticalEntryInput, zone: NonNullable<TacticalSetup['zone']>, rr?: number, stop?: number, zoneStatus?: TacticalSetup['zoneStatus']): TacticalSetup['confirmations'] {
        const triggerDirectionOk = side === 'LONG'
            ? input.h1TriggerCandle.direction === 'BULLISH'
            : input.h1TriggerCandle.direction === 'BEARISH';
        const triggerQualityOk = ['STRONG', 'ACCEPTABLE', 'REJECTION'].includes(input.h1TriggerCandle.quality);
        const oneHourBos = side === 'LONG'
            ? input.h1Structure.bos === 'BULLISH' || input.h1Structure.structure === 'BULLISH_STRUCTURE'
            : input.h1Structure.bos === 'BEARISH' || input.h1Structure.structure === 'BEARISH_STRUCTURE';
        const reclaimOrRetest = side === 'LONG'
            ? ['BOUNCE'].includes(input.h1Levels.nearestSupport?.lastReaction || '') || ['RETESTED', 'RECLAIMED'].includes(input.h1Levels.nearestSupport?.status || '')
            : ['REJECTION'].includes(input.h1Levels.nearestResistance?.lastReaction || '') || ['RETESTED', 'RECLAIMED'].includes(input.h1Levels.nearestResistance?.status || '');
        const cvdOk = side === 'LONG'
            ? input.h1OrderFlow.cvdTrend !== 'DOWN' && input.h1OrderFlow.divergence !== 'BEARISH'
            : input.h1OrderFlow.cvdTrend !== 'UP' && input.h1OrderFlow.divergence !== 'BULLISH';
        const usdtDominanceOk = side === 'LONG'
            ? input.usdtDominance.signalImpact !== 'RISK_OFF' && input.usdtDominance.score > -10
            : input.usdtDominance.signalImpact !== 'RISK_ON' && input.usdtDominance.score < 10;
        const stopDistance = stop ? Math.abs(input.currentPrice - stop) : 0;
        const minStopDistance = input.h1Atr.atr14 * 0.25;

        return {
            inZone: this.isInZone(side, input.currentPrice, zone, input.h1Atr.atr14),
            oneHourBos,
            reclaimOrRetest,
            triggerCandle: triggerDirectionOk && triggerQualityOk,
            cvdOk,
            usdtDominanceOk,
            rrOk: Boolean(rr && rr >= 1.8 && zoneStatus !== 'INVALID_BY_RR'),
            stopDistanceOk: stopDistance >= minStopDistance
        };
    }

    private calculateRequiredEntryForMinRr(side: TacticalDirection, stop: number, input: TacticalEntryInput): number | undefined {
        const target = input.riskManagement.nearestBlockingLevel || (side === 'LONG'
            ? input.h1Levels.nearestResistance?.price
            : input.h1Levels.nearestSupport?.price);
        if (!target) return undefined;

        if (side === 'LONG') {
            const entry = (target + 1.8 * stop) / 2.8;
            if (!Number.isFinite(entry) || entry <= stop || entry >= target) return undefined;
            return roundToTick(entry);
        }

        const entry = (target + 1.8 * stop) / 2.8;
        if (!Number.isFinite(entry) || entry >= stop || entry <= target) return undefined;
        return roundToTick(entry);
    }

    private getZoneStatus(side: TacticalDirection, zone: NonNullable<TacticalSetup['zone']>, requiredEntry?: number, rr?: number): NonNullable<TacticalSetup['zoneStatus']> {
        if (!requiredEntry || rr === undefined) return 'PENDING_RECALCULATION';
        if (rr >= 1.8) return 'VALID';
        const zoneLow = Math.min(zone.from, zone.to);
        const zoneHigh = Math.max(zone.from, zone.to);
        if (side === 'LONG') {
            return requiredEntry < zoneLow ? 'INVALID_BY_RR' : 'PENDING_RECALCULATION';
        }
        return requiredEntry > zoneHigh ? 'INVALID_BY_RR' : 'PENDING_RECALCULATION';
    }

    private isInZone(side: TacticalDirection, price: number, zone: NonNullable<TacticalSetup['zone']>, atr: number): boolean {
        const tolerance = atr > 0 ? atr * 0.15 : Math.abs(zone.to - zone.from) * 0.2;
        const zoneLow = Math.min(zone.from, zone.to);
        const zoneHigh = Math.max(zone.from, zone.to);
        if (side === 'LONG') return price >= zoneLow - tolerance && price <= zoneHigh + tolerance;
        return price >= zoneLow - tolerance && price <= zoneHigh + tolerance;
    }

    private getStatus(confirmations: TacticalSetup['confirmations']): TacticalSetup['status'] {
        if (!confirmations.inZone) return 'WATCH';
        const structureOk = confirmations.oneHourBos || confirmations.reclaimOrRetest;
        const confirmed = structureOk &&
            confirmations.triggerCandle &&
            confirmations.cvdOk &&
            confirmations.usdtDominanceOk &&
            confirmations.rrOk &&
            confirmations.stopDistanceOk;
        if (confirmed) return 'CONFIRMED';

        const partialCount = [
            structureOk,
            confirmations.triggerCandle,
            confirmations.cvdOk,
            confirmations.usdtDominanceOk,
            confirmations.rrOk,
            confirmations.stopDistanceOk
        ].filter(Boolean).length;
        return partialCount >= 3 ? 'CONFIRMATION_PENDING' : 'IN_ZONE';
    }

    private isInvalidated(side: TacticalDirection, input: TacticalEntryInput): boolean {
        const stopLoss = input.riskManagement.stopLoss;
        if (!stopLoss) return false;
        return side === 'LONG' ? input.currentPrice <= stopLoss : input.currentPrice >= stopLoss;
    }

    private buildReason(status: TacticalSetup['status'], side: TacticalDirection, input: TacticalEntryInput, rr?: number): string {
        const sideText = side.toLowerCase();
        if (status === 'WATCH') {
            if (rr !== undefined && rr < 1.8) {
                return `4H bias allows tactical ${sideText}, but current candidate zone does not provide R/R >= 1.8.`;
            }
            return `4H bias allows tactical ${sideText}, but price is not in the tactical zone yet.`;
        }
        if (status === 'CONFIRMED') {
            return `Tactical ${sideText} confirmed on 1H conditions with R/R ${rr?.toFixed(2) || 'n/a'}.`;
        }
        if (status === 'CONFIRMATION_PENDING') {
            return `Price is in tactical ${sideText} zone, but not all 1H confirmations are present.`;
        }
        return `Price is in tactical ${sideText} zone; waiting for 1H confirmation and valid R/R.`;
    }

    private buildWaitingFor(side: TacticalDirection, confirmations: TacticalSetup['confirmations'], requiredEntry?: number, zoneStatus?: TacticalSetup['zoneStatus']): string[] {
        const waiting: string[] = [];
        if (!confirmations.rrOk) {
            const requiredText = requiredEntry ? ` ${side === 'LONG' ? '<=' : '>='} ${requiredEntry}` : '';
            waiting.push(side === 'LONG'
                ? `Deeper pullback to${requiredText} where R/R can become >= 1.8.`
                : `Higher pullback to${requiredText} where R/R can become >= 1.8.`);
            waiting.push('Recalculate 1H stop after the new reaction.');
        }
        if (!confirmations.inZone && zoneStatus !== 'INVALID_BY_RR') {
            waiting.push(side === 'LONG' ? 'Price returns to a valid tactical long zone after R/R recalculation.' : 'Price returns to a valid tactical short zone after R/R recalculation.');
        }
        if (!confirmations.oneHourBos && !confirmations.reclaimOrRetest) waiting.push(side === 'LONG' ? '1H bullish reaction / BOS / reclaim.' : '1H bearish reaction / BOS / retest from below.');
        if (!confirmations.triggerCandle) waiting.push(side === 'LONG' ? '1H bullish trigger candle.' : '1H bearish trigger candle.');
        if (!confirmations.rrOk) waiting.push('R/R >= 1.8 using 1H local stop.');
        if (!confirmations.stopDistanceOk) waiting.push('1H stop distance is not too tight versus ATR.');
        if (!confirmations.cvdOk) waiting.push(side === 'LONG' ? 'CVD is not bearish / delta turns positive.' : 'CVD is not bullish / delta turns negative.');
        if (!confirmations.usdtDominanceOk) waiting.push(side === 'LONG' ? 'USDT.D does not show risk-off.' : 'USDT.D does not show risk-on against short.');
        return waiting;
    }

    private buildInvalidation(side: TacticalDirection, input: TacticalEntryInput, stop?: number, confirmed: boolean = false): string[] {
        const invalidation = [
            input.h4Invalidation || (side === 'LONG' ? '4H closes below main bullish invalidation.' : '4H closes above main bearish invalidation.'),
            side === 'LONG' ? '1H loses bullish structure.' : '1H loses bearish structure.',
            side === 'LONG' ? 'CVD turns bearish.' : 'CVD turns bullish.',
            side === 'LONG' ? 'USDT.D breaks upward / risk-off accelerates.' : 'USDT.D turns risk-on against short.'
        ];
        if (stop) {
            if (confirmed) {
                invalidation.unshift(side === 'LONG' ? `Tactical long invalidated if price breaks 1H stop ${stop}.` : `Tactical short invalidated if price breaks 1H stop ${stop}.`);
            } else {
                invalidation.unshift(side === 'LONG' ? `Candidate 1H stop ${stop} breaks before entry confirmation.` : `Candidate 1H stop ${stop} breaks before entry confirmation.`);
            }
        }
        return invalidation;
    }

    private buildDisabled(reason: string): TacticalSetup {
        return {
            timeframe: '1h',
            status: 'DISABLED',
            side: 'NONE',
            reason,
            confirmations: {
                inZone: false,
                oneHourBos: false,
                reclaimOrRetest: false,
                triggerCandle: false,
                cvdOk: false,
                usdtDominanceOk: false,
                rrOk: false,
                stopDistanceOk: false
            },
            waitingFor: [],
            invalidation: [],
            createdAt: new Date().toISOString()
        };
    }
}
