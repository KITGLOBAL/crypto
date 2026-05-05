import { Candle, OrderFlowAnalysis } from '../types';
import { average, clamp } from '../utils/math';

export class OrderFlowAnalyzer {
    public analyze(candles: Candle[]): OrderFlowAnalysis {
        const deltas = candles.map(candle => this.getDelta(candle));
        const lastDelta = deltas[deltas.length - 1] || 0;
        const avgAbsDelta20 = average(deltas.slice(-21, -1).map(value => Math.abs(value)));
        const deltaRatio = avgAbsDelta20 > 0 ? lastDelta / avgAbsDelta20 : 0;
        const cvd = this.buildCvd(deltas);
        const cvdChange4h = deltas[deltas.length - 1] || 0;
        const cvdChange24h = deltas.slice(-6).reduce((sum, value) => sum + value, 0);
        const cvdShort = cvd[cvd.length - 1] - (cvd[cvd.length - 7] || cvd[0] || 0);
        const cvdTrend = Math.abs(cvdShort) < avgAbsDelta20 ? 'FLAT' : cvdShort > 0 ? 'UP' : 'DOWN';
        const divergence = this.detectDivergence(candles, cvd);

        let score = 0;
        if (cvdTrend === 'UP') score += 7;
        if (cvdTrend === 'DOWN') score -= 7;
        if (deltaRatio > 1.2) score += 5;
        if (deltaRatio < -1.2) score -= 5;
        if (divergence === 'BULLISH') score += 8;
        if (divergence === 'BEARISH') score -= 8;

        const deltaStrength = deltaRatio > 1.2
            ? 'STRONG_POSITIVE'
            : deltaRatio < -1.2
                ? 'STRONG_NEGATIVE'
                : 'NORMAL';
        const impact = this.buildImpact(cvdTrend, deltaStrength, divergence);
        const interpretation = this.buildInterpretation(cvdTrend, deltaRatio, deltaStrength, divergence, impact);

        return {
            deltaCurrent: lastDelta,
            deltaAvg20: avgAbsDelta20,
            deltaRatio,
            deltaStrength,
            cvdChange4h,
            cvdChange24h,
            cvdTrend,
            divergence,
            impact,
            interpretation,
            score: Math.round(clamp(score, -15, 15))
        };
    }

    private getDelta(candle: Candle): number {
        const quoteVolume = candle.quoteVolume || candle.volume * candle.close;
        const takerBuyQuote = candle.takerBuyQuoteVolume || quoteVolume / 2;
        const takerSellQuote = Math.max(quoteVolume - takerBuyQuote, 0);
        return takerBuyQuote - takerSellQuote;
    }

    private buildCvd(deltas: number[]): number[] {
        const cvd: number[] = [];
        deltas.reduce((sum, delta) => {
            const next = sum + delta;
            cvd.push(next);
            return next;
        }, 0);
        return cvd;
    }

    private detectDivergence(candles: Candle[], cvd: number[]): OrderFlowAnalysis['divergence'] {
        if (candles.length < 20 || cvd.length < 20) return 'NONE';
        const recent = candles.slice(-12);
        const previous = candles.slice(-24, -12);
        const recentHigh = Math.max(...recent.map(candle => candle.high));
        const previousHigh = Math.max(...previous.map(candle => candle.high));
        const recentLow = Math.min(...recent.map(candle => candle.low));
        const previousLow = Math.min(...previous.map(candle => candle.low));
        const recentCvdHigh = Math.max(...cvd.slice(-12));
        const previousCvdHigh = Math.max(...cvd.slice(-24, -12));
        const recentCvdLow = Math.min(...cvd.slice(-12));
        const previousCvdLow = Math.min(...cvd.slice(-24, -12));

        if (recentHigh > previousHigh && recentCvdHigh <= previousCvdHigh) return 'BEARISH';
        if (recentLow < previousLow && recentCvdLow >= previousCvdLow) return 'BULLISH';
        return 'NONE';
    }

    private buildImpact(
        cvdTrend: OrderFlowAnalysis['cvdTrend'],
        deltaStrength: OrderFlowAnalysis['deltaStrength'],
        divergence: OrderFlowAnalysis['divergence']
    ): string {
        if (divergence === 'BULLISH') return 'bullish divergence';
        if (divergence === 'BEARISH') return 'bearish divergence';
        if (cvdTrend === 'UP' && deltaStrength === 'STRONG_POSITIVE') return 'bullish confirmation';
        if (cvdTrend === 'DOWN' && deltaStrength === 'STRONG_NEGATIVE') return 'bearish confirmation';
        if (cvdTrend === 'UP') return 'mild buyer control';
        if (cvdTrend === 'DOWN') return 'mild seller control';
        return 'neutral order-flow';
    }

    private buildInterpretation(
        cvdTrend: OrderFlowAnalysis['cvdTrend'],
        deltaRatio: number,
        deltaStrength: OrderFlowAnalysis['deltaStrength'],
        divergence: OrderFlowAnalysis['divergence'],
        impact: string
    ): string {
        const deltaText = deltaStrength === 'STRONG_POSITIVE'
            ? `current 4H delta is strongly positive (${deltaRatio.toFixed(2)}x average)`
            : deltaStrength === 'STRONG_NEGATIVE'
                ? `current 4H delta is strongly negative (${Math.abs(deltaRatio).toFixed(2)}x average)`
                : `current 4H delta is normal (${Math.abs(deltaRatio).toFixed(2)}x average)`;
        const divergenceText = divergence === 'NONE' ? 'no clear CVD divergence' : `${divergence.toLowerCase()} CVD divergence`;
        return `CVD trend ${cvdTrend}, ${deltaText}, ${divergenceText}, impact ${impact}`;
    }
}
