import {
    AtrAnalysis,
    Candle,
    KeyLevel,
    LevelsAnalysis,
    MarketRegimeAnalysis,
    MarketStructureAnalysis,
    RetestAnalysis,
    TriggerCandleAnalysis,
    TrendAnalysis,
    TrendState,
    VolumeAnalysis
} from '../types';
import { atr, average, clamp, detectSwings, roundToTick, sma } from '../utils/math';

export class TechnicalAnalyzers {
    public analyzeTrend(candles: Candle[]): TrendAnalysis {
        const closes = candles.map(candle => candle.close);
        const close = closes[closes.length - 1] || 0;
        const sma20 = sma(closes, 20);
        const sma50 = sma(closes, 50);
        const atr14 = atr(candles, 14);
        const distanceFromSma20Atr = atr14 > 0 ? (close - sma20) / atr14 : 0;

        let trend: TrendState = 'UNCLEAR';
        if (close > sma20 && sma20 > sma50) trend = 'UPTREND';
        else if (close < sma20 && sma20 < sma50) trend = 'DOWNTREND';
        else if (Math.abs(distanceFromSma20Atr) < 0.8) trend = 'RANGE';

        return { trend, close, sma20, sma50, distanceFromSma20Atr };
    }

    public analyzeMarketStructure(candles: Candle[]): MarketStructureAnalysis {
        const swings = detectSwings(candles, 3);
        const highs = swings.filter(item => item.type === 'HIGH');
        const lows = swings.filter(item => item.type === 'LOW');
        const lastSwingHigh = highs[highs.length - 1];
        const previousSwingHigh = highs[highs.length - 2];
        const lastSwingLow = lows[lows.length - 1];
        const previousSwingLow = lows[lows.length - 2];
        const close = candles[candles.length - 1]?.close || 0;

        let bos: MarketStructureAnalysis['bos'] = 'NONE';
        if (lastSwingHigh && close > lastSwingHigh.price) bos = 'BULLISH';
        if (lastSwingLow && close < lastSwingLow.price) bos = 'BEARISH';

        let trend: TrendState = 'UNCLEAR';
        if (lastSwingHigh && previousSwingHigh && lastSwingLow && previousSwingLow) {
            const higherHigh = lastSwingHigh.price > previousSwingHigh.price;
            const higherLow = lastSwingLow.price > previousSwingLow.price;
            const lowerHigh = lastSwingHigh.price < previousSwingHigh.price;
            const lowerLow = lastSwingLow.price < previousSwingLow.price;

            if (higherHigh && higherLow) trend = 'UPTREND';
            else if (lowerHigh && lowerLow) trend = 'DOWNTREND';
            else trend = 'RANGE';
        }

        const structure =
            trend === 'UPTREND' || bos === 'BULLISH' ? 'BULLISH_STRUCTURE' :
            trend === 'DOWNTREND' || bos === 'BEARISH' ? 'BEARISH_STRUCTURE' :
            trend === 'RANGE' ? 'RANGE' : 'UNCLEAR';

        let choch: MarketStructureAnalysis['choch'] = 'NONE';
        if (trend === 'DOWNTREND' && bos === 'BULLISH') choch = 'BULLISH';
        if (trend === 'UPTREND' && bos === 'BEARISH') choch = 'BEARISH';

        return {
            trend,
            structure,
            lastSwingHigh,
            lastSwingLow,
            previousSwingHigh,
            previousSwingLow,
            bos,
            choch
        };
    }

    public analyzeVolume(candles: Candle[], directionalBias: number): VolumeAnalysis {
        const volumes = candles.map(candle => candle.volume);
        const current = volumes[volumes.length - 1] || 0;
        const avg20 = average(volumes.slice(-21, -1));
        const avgPrevious20 = average(volumes.slice(-41, -21));
        const ratio = avg20 > 0 ? current / avg20 : 1;
        const trend = avgPrevious20 > 0 && avg20 > avgPrevious20 * 1.08
            ? 'RISING'
            : avgPrevious20 > 0 && avg20 < avgPrevious20 * 0.92
                ? 'FALLING'
                : 'FLAT';
        const signal = ratio >= 1.5 ? 'HIGH_CONFIRMATION' : ratio <= 0.65 ? 'LOW_PARTICIPATION' : 'NORMAL';

        let score = 0;
        if (signal === 'HIGH_CONFIRMATION') score = directionalBias >= 0 ? 8 : -8;
        if (signal === 'LOW_PARTICIPATION') score = directionalBias >= 0 ? -4 : 4;

        return { current, avg20, ratio, trend, signal, score };
    }

    public analyzeAtr(candles: Candle[]): AtrAnalysis {
        const atr14 = atr(candles, 14);
        const close = candles[candles.length - 1]?.close || 0;
        return {
            atr14,
            atrPercent: close > 0 ? (atr14 / close) * 100 : 0
        };
    }

    public analyzeLevels(candles: Candle[], timeframe: '1d' | '4h'): LevelsAnalysis {
        const swings = detectSwings(candles, 3).slice(-40);
        const close = candles[candles.length - 1]?.close || 0;
        const atr14 = atr(candles, 14);
        const clusterSize = atr14 > 0 ? atr14 * 0.35 : close * 0.005;
        const rawLevels: KeyLevel[] = swings.map(swing => {
            const type = swing.type === 'LOW' ? 'support' : 'resistance';
            const touchCount = this.countTouches(candles, swing.price, clusterSize, type);
            const volumeScore = this.getLevelVolumeScore(candles, swing.index, 8);
            const status = this.getLevelStatus(candles, swing.price, type, atr14);
            const lastReaction = this.getLastReaction(candles, swing.price, type, atr14);
            const distancePct = close > 0 ? Math.abs((swing.price - close) / close) * 100 : 0;
            const strength = clamp(touchCount * 1.5 + volumeScore + (status === 'RETESTED' || status === 'RECLAIMED' ? 2 : 0), 1, 10);

            return {
                price: roundToTick(swing.price),
                type,
                timeframe,
                strength: Number(strength.toFixed(1)),
                touchCount,
                volumeScore: Number(volumeScore.toFixed(1)),
                status,
                lastReaction,
                distancePct: Number(distancePct.toFixed(2))
            };
        });
        const levels = this.mergeNearbyLevels(rawLevels, clusterSize);

        const supports = levels
            .filter(level => level.type === 'support' && level.price < close)
            .sort((a, b) => b.price - a.price)
            .slice(0, 6);
        const resistances = levels
            .filter(level => level.type === 'resistance' && level.price > close)
            .sort((a, b) => a.price - b.price)
            .slice(0, 6);

        const recentRange = candles.slice(-80);
        const fallbackLow = roundToTick(Math.min(...recentRange.map(candle => candle.low)));
        const fallbackHigh = roundToTick(Math.max(...recentRange.map(candle => candle.high)));
        const rangeLow = supports[supports.length - 1]?.price || fallbackLow;
        const rangeHigh = resistances[resistances.length - 1]?.price || fallbackHigh;
        let premiumDiscount: LevelsAnalysis['premiumDiscount'] = 'UNKNOWN';

        if (rangeLow && rangeHigh && rangeHigh > rangeLow) {
            const boundedClose = Math.max(rangeLow, Math.min(rangeHigh, close));
            const position = (boundedClose - rangeLow) / (rangeHigh - rangeLow);
            premiumDiscount = position > 0.6 ? 'PREMIUM' : position < 0.4 ? 'DISCOUNT' : 'EQUILIBRIUM';
        }

        if (!supports[0] && fallbackLow < close) {
            supports.push({
                price: fallbackLow,
                type: 'support',
                timeframe,
                strength: 1,
                touchCount: 1,
                volumeScore: 1,
                status: 'ACTIVE',
                lastReaction: 'NONE',
                distancePct: close > 0 ? Number((((close - fallbackLow) / close) * 100).toFixed(2)) : 0
            });
        }

        if (!resistances[0] && fallbackHigh > close) {
            resistances.push({
                price: fallbackHigh,
                type: 'resistance',
                timeframe,
                strength: 1,
                touchCount: 1,
                volumeScore: 1,
                status: 'ACTIVE',
                lastReaction: 'NONE',
                distancePct: close > 0 ? Number((((fallbackHigh - close) / close) * 100).toFixed(2)) : 0
            });
        }

        return {
            supports,
            resistances,
            nearestSupport: supports[0],
            nearestResistance: resistances[0],
            rangeLow,
            rangeHigh,
            premiumDiscount,
            summary: `Nearest support ${supports[0]?.price || 'n/a'} (${supports[0]?.status || 'n/a'}, touches ${supports[0]?.touchCount || 0}); nearest resistance ${resistances[0]?.price || 'n/a'} (${resistances[0]?.status || 'n/a'}, touches ${resistances[0]?.touchCount || 0}).`
        };
    }

    public analyzeTriggerCandle(candles: Candle[], volume: VolumeAnalysis): TriggerCandleAnalysis {
        const candle = candles[candles.length - 1];
        if (!candle) {
            return {
                direction: 'NEUTRAL',
                bodyPct: 0,
                upperWickPct: 0,
                lowerWickPct: 0,
                closeLocation: 0.5,
                volumeRatio: 0,
                quality: 'WEAK',
                score: 0,
                summary: 'Trigger candle unavailable.'
            };
        }

        const range = Math.max(candle.high - candle.low, 0);
        const body = Math.abs(candle.close - candle.open);
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const bodyPct = range > 0 ? body / range : 0;
        const upperWickPct = range > 0 ? upperWick / range : 0;
        const lowerWickPct = range > 0 ? lowerWick / range : 0;
        const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0.5;
        const direction = bodyPct < 0.2
            ? 'NEUTRAL'
            : candle.close > candle.open
                ? 'BULLISH'
                : 'BEARISH';

        let score = 0;
        if (bodyPct >= 0.5) score += 4;
        if (volume.ratio >= 1.5) score += 3;
        if (direction === 'BULLISH' && closeLocation >= 0.7 && upperWickPct <= 0.35) score += 4;
        if (direction === 'BEARISH' && closeLocation <= 0.3 && lowerWickPct <= 0.35) score -= 4;
        if (upperWickPct > 0.5 && direction === 'BULLISH') score -= 5;
        if (lowerWickPct > 0.5 && direction === 'BEARISH') score += 5;

        const quality = bodyPct >= 0.5 && volume.ratio >= 1.2 && ((direction === 'BULLISH' && closeLocation >= 0.65) || (direction === 'BEARISH' && closeLocation <= 0.35))
            ? 'STRONG'
            : bodyPct >= 0.35 && volume.ratio >= 0.9
                ? 'ACCEPTABLE'
                : (direction === 'BULLISH' && lowerWickPct > 0.5) || (direction === 'BEARISH' && upperWickPct > 0.5)
                    ? 'REJECTION'
                    : 'WEAK';
        const rejectionContext = quality === 'REJECTION'
            ? direction === 'BULLISH'
                ? 'bullish rejection from lower prices'
                : direction === 'BEARISH'
                    ? 'bearish rejection from higher prices'
                    : 'indecision rejection'
            : `${quality.toLowerCase()} trigger`;

        return {
            direction,
            bodyPct: Number((bodyPct * 100).toFixed(1)),
            upperWickPct: Number((upperWickPct * 100).toFixed(1)),
            lowerWickPct: Number((lowerWickPct * 100).toFixed(1)),
            closeLocation: Number((closeLocation * 100).toFixed(1)),
            volumeRatio: Number(volume.ratio.toFixed(2)),
            quality,
            score: Math.round(clamp(score, -10, 10)),
            summary: `${rejectionContext}: body ${(bodyPct * 100).toFixed(1)}%, close location ${(closeLocation * 100).toFixed(1)}%, volume ${volume.ratio.toFixed(2)}x.`
        };
    }

    public analyzeRetest(candles: Candle[], levels: LevelsAnalysis): RetestAnalysis {
        const atr14 = atr(candles, 14);
        const recent = candles.slice(-8);
        const previous = candles.slice(-24, -8);
        if (recent.length < 4 || previous.length < 8 || atr14 <= 0) {
            return { direction: 'NONE', state: 'NONE', summary: 'Retest data insufficient.', score: 0 };
        }

        const previousHigh = Math.max(...previous.map(candle => candle.high));
        const previousLow = Math.min(...previous.map(candle => candle.low));
        const tolerance = atr14 * 0.25;

        const bullishBreakIndex = recent.findIndex(candle => candle.close > previousHigh);
        if (bullishBreakIndex >= 0) {
            const afterBreak = recent.slice(bullishBreakIndex + 1);
            const retest = afterBreak.find(candle => candle.low <= previousHigh + tolerance);
            if (retest && retest.close > previousHigh) {
                return { direction: 'BULLISH', state: 'CONFIRMED', level: roundToTick(previousHigh), candlesSinceBreakout: recent.length - bullishBreakIndex - 1, summary: `Bullish breakout retested ${roundToTick(previousHigh)} as support.`, score: 8 };
            }
            if (afterBreak.some(candle => candle.close < previousHigh - tolerance)) {
                return { direction: 'BULLISH', state: 'FAILED', level: roundToTick(previousHigh), candlesSinceBreakout: recent.length - bullishBreakIndex - 1, summary: `Bullish breakout above ${roundToTick(previousHigh)} failed back below level.`, score: -8 };
            }
            return { direction: 'BULLISH', state: 'PENDING', level: roundToTick(previousHigh), candlesSinceBreakout: recent.length - bullishBreakIndex - 1, summary: `Bullish breakout above ${roundToTick(previousHigh)} detected; retest still pending.`, score: 2 };
        }

        const bearishBreakIndex = recent.findIndex(candle => candle.close < previousLow);
        if (bearishBreakIndex >= 0) {
            const afterBreak = recent.slice(bearishBreakIndex + 1);
            const retest = afterBreak.find(candle => candle.high >= previousLow - tolerance);
            if (retest && retest.close < previousLow) {
                return { direction: 'BEARISH', state: 'CONFIRMED', level: roundToTick(previousLow), candlesSinceBreakout: recent.length - bearishBreakIndex - 1, summary: `Bearish breakdown retested ${roundToTick(previousLow)} as resistance.`, score: -8 };
            }
            if (afterBreak.some(candle => candle.close > previousLow + tolerance)) {
                return { direction: 'BEARISH', state: 'FAILED', level: roundToTick(previousLow), candlesSinceBreakout: recent.length - bearishBreakIndex - 1, summary: `Bearish breakdown below ${roundToTick(previousLow)} failed back above level.`, score: 8 };
            }
            return { direction: 'BEARISH', state: 'PENDING', level: roundToTick(previousLow), candlesSinceBreakout: recent.length - bearishBreakIndex - 1, summary: `Bearish breakdown below ${roundToTick(previousLow)} detected; retest still pending.`, score: -2 };
        }

        const levelText = levels.nearestSupport || levels.nearestResistance ? `Nearest levels: support ${levels.nearestSupport?.price || 'n/a'}, resistance ${levels.nearestResistance?.price || 'n/a'}.` : 'No nearby retest level.';
        return { direction: 'NONE', state: 'NONE', summary: `No confirmed breakout/retest. ${levelText}`, score: 0 };
    }

    public analyzeMarketRegime(candles: Candle[], structure: MarketStructureAnalysis, levels: LevelsAnalysis, volume: VolumeAnalysis): MarketRegimeAnalysis {
        const closes = candles.map(candle => candle.close);
        const currentAtr = atr(candles, 14);
        const atrSeries = candles.slice(-60).map((_, index, arr) => atr(candles.slice(0, candles.length - arr.length + index + 1), 14)).filter(value => value > 0);
        const atrAvg = average(atrSeries);
        const atrCompressionRatio = atrAvg > 0 ? currentAtr / atrAvg : 1;
        const close = closes[closes.length - 1] || 0;
        const rangeLow = levels.rangeLow || Math.min(...candles.slice(-80).map(candle => candle.low));
        const rangeHigh = levels.rangeHigh || Math.max(...candles.slice(-80).map(candle => candle.high));
        const rangePositionValue = rangeHigh > rangeLow ? (close - rangeLow) / (rangeHigh - rangeLow) : 0.5;
        const rangePosition = rangePositionValue < 0.33 ? 'LOW' : rangePositionValue > 0.67 ? 'HIGH' : 'MID';
        const volatilityState = atrCompressionRatio < 0.75 ? 'CONTRACTING' : atrCompressionRatio > 1.25 ? 'EXPANDING' : 'NORMAL';

        let regime: MarketRegimeAnalysis['regime'] = 'UNCLEAR';
        if (volatilityState === 'CONTRACTING' && structure.structure === 'RANGE') regime = 'COMPRESSION';
        else if (volatilityState === 'EXPANDING' && Math.abs((close - sma(closes, 20)) / (currentAtr || 1)) > 1.8) regime = 'EXPANSION';
        else if (structure.structure === 'RANGE' && rangePosition === 'LOW' && volume.trend !== 'FALLING') regime = 'ACCUMULATION';
        else if (structure.structure === 'RANGE' && rangePosition === 'HIGH' && volume.trend !== 'FALLING') regime = 'DISTRIBUTION';
        else if (structure.structure === 'BULLISH_STRUCTURE') regime = 'TRENDING_UP';
        else if (structure.structure === 'BEARISH_STRUCTURE') regime = 'TRENDING_DOWN';
        else if (structure.structure === 'RANGE') regime = 'RANGE';
        else if (volatilityState === 'CONTRACTING') regime = 'LOW_VOLATILITY';
        else if (volatilityState === 'EXPANDING') regime = 'HIGH_VOLATILITY';

        const score = regime === 'TRENDING_UP' || regime === 'ACCUMULATION'
            ? 6
            : regime === 'TRENDING_DOWN' || regime === 'DISTRIBUTION'
                ? -6
                : regime === 'COMPRESSION'
                    ? 0
                    : regime === 'EXPANSION'
                        ? -4
                        : 0;

        return {
            regime,
            rangePosition,
            volatilityState,
            volumeState: volume.trend,
            atrCompressionRatio: Number(atrCompressionRatio.toFixed(2)),
            summary: `${regime}: range position ${rangePosition}, volatility ${volatilityState} (${atrCompressionRatio.toFixed(2)}x ATR baseline), volume ${volume.trend}.`,
            score
        };
    }

    private countTouches(candles: Candle[], price: number, tolerance: number, type: KeyLevel['type']): number {
        return candles.slice(-120).filter(candle => {
            if (type === 'support') return Math.abs(candle.low - price) <= tolerance;
            return Math.abs(candle.high - price) <= tolerance;
        }).length;
    }

    private getLevelVolumeScore(candles: Candle[], index: number, window: number): number {
        const avgVolume = average(candles.slice(Math.max(0, index - 40), index).map(candle => candle.volume));
        const localVolume = average(candles.slice(Math.max(0, index - window), Math.min(candles.length, index + window + 1)).map(candle => candle.volume));
        if (avgVolume <= 0) return 1;
        return clamp(localVolume / avgVolume, 0.5, 3);
    }

    private getLevelStatus(candles: Candle[], price: number, type: KeyLevel['type'], atr14: number): KeyLevel['status'] {
        const tolerance = atr14 > 0 ? atr14 * 0.2 : price * 0.003;
        const recent = candles.slice(-12);
        const last = candles[candles.length - 1];
        if (!last) return 'ACTIVE';

        if (type === 'support') {
            const broken = recent.some(candle => candle.close < price - tolerance);
            const reclaimed = broken && last.close > price + tolerance;
            const retested = last.low <= price + tolerance && last.close > price;
            if (reclaimed) return 'RECLAIMED';
            if (retested) return 'RETESTED';
            if (broken) return 'BROKEN';
            return 'ACTIVE';
        }

        const broken = recent.some(candle => candle.close > price + tolerance);
        const reclaimed = broken && last.close < price - tolerance;
        const retested = last.high >= price - tolerance && last.close < price;
        if (reclaimed) return 'RECLAIMED';
        if (retested) return 'RETESTED';
        if (broken) return 'BROKEN';
        return 'ACTIVE';
    }

    private getLastReaction(candles: Candle[], price: number, type: KeyLevel['type'], atr14: number): KeyLevel['lastReaction'] {
        const tolerance = atr14 > 0 ? atr14 * 0.25 : price * 0.004;
        const recent = candles.slice(-8).reverse();
        for (const candle of recent) {
            if (type === 'support' && candle.low <= price + tolerance) {
                if (candle.close > price) return 'BOUNCE';
                return 'BREAK';
            }
            if (type === 'resistance' && candle.high >= price - tolerance) {
                if (candle.close < price) return 'REJECTION';
                return 'BREAK';
            }
        }
        return 'NONE';
    }

    private mergeNearbyLevels(levels: KeyLevel[], clusterSize: number): KeyLevel[] {
        const sorted = [...levels].sort((a, b) => a.price - b.price);
        const merged: KeyLevel[] = [];

        sorted.forEach(level => {
            const existing = merged.find(item => item.type === level.type && Math.abs(item.price - level.price) <= clusterSize);
            if (!existing) {
                merged.push({ ...level });
                return;
            }

            const totalTouches = existing.touchCount + level.touchCount;
            existing.price = roundToTick(((existing.price * existing.touchCount) + (level.price * level.touchCount)) / totalTouches);
            existing.touchCount = totalTouches;
            existing.volumeScore = Number(Math.max(existing.volumeScore, level.volumeScore).toFixed(1));
            existing.strength = Number(Math.min(10, existing.strength + level.strength * 0.45).toFixed(1));
            existing.distancePct = Math.min(existing.distancePct, level.distancePct);
            if (level.status === 'RECLAIMED' || level.status === 'RETESTED') existing.status = level.status;
        });

        return merged.sort((a, b) => b.strength - a.strength);
    }
}
