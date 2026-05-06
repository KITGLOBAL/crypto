import { MarketDataService } from '../../services/MarketDataService';
import { Candle, DerivativesAnalysis } from '../types';
import { average, clamp } from '../utils/math';

export class DerivativesService {
    constructor(private marketDataService: MarketDataService) {}

    public async analyze(symbol: string, h4Candles: Candle[]): Promise<DerivativesAnalysis> {
        const [stats, fundingHistory, oiHistory] = await Promise.all([
            this.marketDataService.getAssetStats(symbol),
            this.marketDataService.getFundingHistory(symbol, 90),
            this.marketDataService.getOpenInterestHistory(symbol, '4h', 60)
        ]);
        const last = h4Candles[h4Candles.length - 1];
        const prev = h4Candles[h4Candles.length - 2];
        const priceChange4h = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
        const fundingRates = fundingHistory.map(item => item.fundingRate);

        if (!stats) {
            return {
                fundingRate: 0,
                fundingAvg30d: average(fundingRates),
                fundingZScore30d: 0,
                fundingPercentile30d: 50,
                openInterestUsd: 0,
                longShortRatio: 1,
                shortLongRatio: 1,
                priceChange4h,
                oiChange4h: 0,
                oiChange24h: 0,
                oiChange7d: 0,
                priceOiDivergence: 'NONE',
                oiInterpretation: 'OI unavailable',
                fundingInterpretation: 'Funding unavailable',
                positioningInterpretation: 'Positioning unavailable',
                score: 0
            };
        }

        const fundingRate = stats.fundingRate;
        const longShortRatio = stats.longShortRatio || 1;
        const shortLongRatio = longShortRatio > 0 ? 1 / longShortRatio : 1;
        const fundingAvg30d = average(fundingRates);
        const fundingStd30d = this.standardDeviation(fundingRates);
        const fundingZScore30d = fundingStd30d > 0 ? (fundingRate - fundingAvg30d) / fundingStd30d : 0;
        const fundingPercentile30d = this.percentileRank(fundingRates, fundingRate);
        const oiChange4h = this.percentChangeFromHistory(oiHistory.map(item => item.openInterestUsd), 1, stats.openInterest);
        const oiChange24h = this.percentChangeFromHistory(oiHistory.map(item => item.openInterestUsd), 6, stats.openInterest);
        const oiChange7d = this.percentChangeFromHistory(oiHistory.map(item => item.openInterestUsd), 42, stats.openInterest);
        const priceOiDivergence = this.classifyPriceOiDivergence(priceChange4h, oiChange4h, oiChange24h);
        let score = 0;

        const fundingPercent = fundingRate * 100;
        let fundingInterpretation = 'Funding near neutral';
        if (fundingRate > 0.0005) {
            fundingInterpretation = `Funding elevated positive (${fundingPercent.toFixed(4)}%), longs may be crowded`;
            score -= 6;
        } else if (fundingRate < -0.0003) {
            fundingInterpretation = `Funding meaningfully negative (${fundingPercent.toFixed(4)}%), shorts may be crowded`;
            score += 5;
        } else if (fundingRate < -0.00002) {
            fundingInterpretation = `Funding slightly negative (${fundingPercent.toFixed(4)}%), close to neutral`;
            score += 2;
        } else if (fundingRate > 0.00002) {
            fundingInterpretation = `Funding slightly positive (${fundingPercent.toFixed(4)}%), close to neutral`;
            score += 1;
        } else if (Math.abs(fundingRate) <= 0.0002) {
            score += 3;
        }
        if (fundingZScore30d >= 2 && fundingPercentile30d >= 95) {
            fundingInterpretation += `; 30d funding extreme high (rank ${fundingPercentile30d.toFixed(0)}/100, z ${fundingZScore30d.toFixed(2)})`;
            score -= 5;
        } else if (fundingPercentile30d >= 95) {
            fundingInterpretation += `; 30d funding local high rank ${fundingPercentile30d.toFixed(0)}/100, but z ${fundingZScore30d.toFixed(2)} is not extreme`;
            score -= 2;
        } else if (fundingZScore30d <= -2 && fundingPercentile30d <= 5) {
            fundingInterpretation += `; 30d funding extreme low (rank ${fundingPercentile30d.toFixed(0)}/100, z ${fundingZScore30d.toFixed(2)})`;
            score += 5;
        } else if (fundingPercentile30d <= 5) {
            fundingInterpretation += `; 30d funding local low rank ${fundingPercentile30d.toFixed(0)}/100, but z ${fundingZScore30d.toFixed(2)} is not extreme`;
            score += 3;
        } else {
            fundingInterpretation += `; 30d rank ${fundingPercentile30d.toFixed(0)}/100, z ${fundingZScore30d.toFixed(2)}`;
        }

        let positioningInterpretation = 'Top trader positioning neutral';
        if (longShortRatio >= 2.5) {
            positioningInterpretation = `Top Trader Long/Short Ratio ${longShortRatio.toFixed(2)}; overlong, longs exceed shorts by ~${longShortRatio.toFixed(2)}x`;
            score -= 8;
        } else if (longShortRatio >= 1.5) {
            positioningInterpretation = `Top Trader Long/Short Ratio ${longShortRatio.toFixed(2)}; long-biased, longs exceed shorts by ~${longShortRatio.toFixed(2)}x`;
            score -= 3;
        } else if (longShortRatio <= 0.5) {
            positioningInterpretation = `Top Trader Long/Short Ratio ${longShortRatio.toFixed(2)}; overshort, shorts exceed longs by ~${shortLongRatio.toFixed(2)}x`;
            score += 7;
        } else if (longShortRatio <= 0.7) {
            positioningInterpretation = `Top Trader Long/Short Ratio ${longShortRatio.toFixed(2)}; short-biased, shorts exceed longs by ~${shortLongRatio.toFixed(2)}x`;
            score += 3;
        }

        let oiInterpretation = 'OI context neutral';
        if (priceOiDivergence === 'LEVERAGE_BUILDUP') {
            oiInterpretation = oiChange4h < 0
                ? `OI mixed: 4H OI fell ${Math.abs(oiChange4h).toFixed(2)}%, but 24H OI rose ${oiChange24h.toFixed(2)}%. Leverage buildup exists on the wider window, but short-term OI is cooling.`
                : `OI rising while price is flat/weak (4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%): leverage buildup, squeeze risk increases`;
            score -= 2;
        } else if (priceOiDivergence === 'DELEVERAGING') {
            oiInterpretation = `OI falling while price moves (4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%): deleveraging/position closing`;
        } else if (priceChange4h > 0.6 && fundingPercentile30d < 90 && longShortRatio < 1.5) {
            if (oiChange7d >= 15 && fundingRate < 0 && longShortRatio <= 0.7) {
                oiInterpretation = `OI rose notably over 7d (${oiChange7d.toFixed(2)}%) while funding is negative and top traders are short-biased. This does not confirm long crowding, but increases squeeze-scenario probability if resistance breaks. OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
            } else {
                oiInterpretation = `Price rising without extreme funding/long crowding; OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
            }
            score += 5;
        } else if (priceChange4h > 0.6 && (fundingPercentile30d >= 90 || fundingRate > 0.0005 || longShortRatio >= 1.5)) {
            oiInterpretation = `Price rising while funding/positioning looks crowded (funding 30d rank ${fundingPercentile30d.toFixed(0)}/100, top trader L/S ${longShortRatio.toFixed(2)}); OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
            score -= 7;
        } else if (priceChange4h < -0.6 && fundingRate >= -0.0003 && longShortRatio > 0.7) {
            oiInterpretation = `Price falling without clear short overcrowding; OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
            score -= 4;
        } else if (priceChange4h < -0.6 && (fundingRate < -0.0003 || longShortRatio <= 0.7)) {
            oiInterpretation = `Price falling while shorts look crowded, squeeze risk exists; OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
            score += 4;
        } else {
            oiInterpretation = `OI context neutral; OI 4h ${oiChange4h.toFixed(2)}%, 24h ${oiChange24h.toFixed(2)}%, 7d ${oiChange7d.toFixed(2)}%`;
        }

        return {
            fundingRate,
            fundingAvg30d,
            fundingZScore30d: Number(fundingZScore30d.toFixed(2)),
            fundingPercentile30d: Number(fundingPercentile30d.toFixed(0)),
            openInterestUsd: stats.openInterest,
            longShortRatio,
            shortLongRatio,
            priceChange4h,
            oiChange4h: Number(oiChange4h.toFixed(2)),
            oiChange24h: Number(oiChange24h.toFixed(2)),
            oiChange7d: Number(oiChange7d.toFixed(2)),
            priceOiDivergence,
            oiInterpretation,
            fundingInterpretation,
            positioningInterpretation,
            score: Math.max(-20, Math.min(20, score))
        };
    }

    private percentChangeFromHistory(values: number[], periodsBack: number, current: number): number {
        if (values.length === 0 || current <= 0) return 0;
        const index = Math.max(0, values.length - 1 - periodsBack);
        const previous = values[index] || values[0];
        if (!previous || previous <= 0) return 0;
        return ((current - previous) / previous) * 100;
    }

    private classifyPriceOiDivergence(priceChange4h: number, oiChange4h: number, oiChange24h: number): DerivativesAnalysis['priceOiDivergence'] {
        if (Math.abs(priceChange4h) < 0.35 && oiChange24h > 5) return 'LEVERAGE_BUILDUP';
        if (Math.abs(priceChange4h) > 0.8 && oiChange4h < -2) return 'DELEVERAGING';
        if (priceChange4h > 0.6 && oiChange4h < -1) return 'BEARISH';
        if (priceChange4h < -0.6 && oiChange4h < -1) return 'BULLISH';
        return 'NONE';
    }

    private standardDeviation(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = average(values);
        const variance = average(values.map(value => Math.pow(value - mean, 2)));
        return Math.sqrt(variance);
    }

    private percentileRank(values: number[], current: number): number {
        if (values.length === 0) return 50;
        const belowOrEqual = values.filter(value => value <= current).length;
        return clamp((belowOrEqual / values.length) * 100, 0, 100);
    }
}
