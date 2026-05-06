import { Candle, SwingPoint } from '../types';

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sma(values: number[], period: number): number {
    if (values.length === 0) return 0;
    return average(values.slice(-period));
}

export function atr(candles: Candle[], period: number = 14): number {
    if (candles.length < 2) return 0;
    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const current = candles[i];
        const previous = candles[i - 1];
        trueRanges.push(Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        ));
    }

    return sma(trueRanges, period);
}

export function detectSwings(candles: Candle[], lookback: number = 3): SwingPoint[] {
    const swings: SwingPoint[] = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        const candle = candles[i];
        const left = candles.slice(i - lookback, i);
        const right = candles.slice(i + 1, i + lookback + 1);
        const isHigh = left.every(item => candle.high > item.high) && right.every(item => candle.high > item.high);
        const isLow = left.every(item => candle.low < item.low) && right.every(item => candle.low < item.low);

        if (isHigh) {
            swings.push({ index: i, time: candle.closeTime, price: candle.high, type: 'HIGH' });
        }

        if (isLow) {
            swings.push({ index: i, time: candle.closeTime, price: candle.low, type: 'LOW' });
        }
    }

    return swings;
}

export function roundToTick(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value >= 1000) return Number(value.toFixed(1));
    if (value >= 100) return Number(value.toFixed(2));
    if (value >= 1) return Number(value.toFixed(4));
    return Number(value.toFixed(6));
}
