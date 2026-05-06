import { Candle, Timeframe } from '../types';
import { RedisService } from '../../services/RedisService';

const BINANCE_INTERVALS: Record<Timeframe, string> = {
    '1w': '1w',
    '1d': '1d',
    '4h': '4h',
    '1h': '1h'
};

const DEFAULT_LIMITS: Record<Timeframe, number> = {
    '1w': 110,
    '1d': 370,
    '4h': 1100,
    '1h': 1000
};

export class CandleService {
    private readonly baseUrl = 'https://fapi.binance.com';

    constructor(private redis: RedisService) {}

    public async getCurrentPrice(symbol: string): Promise<number> {
        const normalizedSymbol = symbol.toUpperCase();
        const url = `${this.baseUrl}/fapi/v1/ticker/price?symbol=${normalizedSymbol}`;
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`Binance ticker failed: HTTP ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as { price?: string };
        const price = Number(data.price);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Binance ticker returned invalid price for ${normalizedSymbol}`);
        }

        return price;
    }

    public async getCandles(symbol: string, timeframe: Timeframe, limit: number = DEFAULT_LIMITS[timeframe]): Promise<Candle[]> {
        const normalizedSymbol = symbol.toUpperCase();
        const cacheKey = `candles:v1:${normalizedSymbol}:${timeframe}:${limit}`;

        return this.redis.getOrFetch<Candle[]>(cacheKey, async () => {
            const interval = BINANCE_INTERVALS[timeframe];
            const url = `${this.baseUrl}/fapi/v1/klines?symbol=${normalizedSymbol}&interval=${interval}&limit=${limit}`;
            const res = await fetch(url);

            if (!res.ok) {
                throw new Error(`Binance candles failed: HTTP ${res.status} ${res.statusText}`);
            }

            const rows = await res.json() as any[];
            return rows.map(row => ({
                symbol: normalizedSymbol,
                exchange: 'binance-futures',
                timeframe,
                openTime: Number(row[0]),
                open: Number(row[1]),
                high: Number(row[2]),
                low: Number(row[3]),
                close: Number(row[4]),
                volume: Number(row[5]),
                closeTime: Number(row[6]),
                quoteVolume: Number(row[7]),
                takerBuyBaseVolume: Number(row[9]),
                takerBuyQuoteVolume: Number(row[10])
            }));
        }, this.getCandlesCacheTtl(timeframe));
    }

    public async getMultiTimeframeCandles(symbol: string): Promise<Record<Timeframe, Candle[]>> {
        const [weekly, daily, h4, h1] = await Promise.all([
            this.getCandles(symbol, '1w'),
            this.getCandles(symbol, '1d'),
            this.getCandles(symbol, '4h'),
            this.getCandles(symbol, '1h')
        ]);

        return {
            '1w': weekly,
            '1d': daily,
            '4h': h4,
            '1h': h1
        };
    }

    private getCandlesCacheTtl(timeframe: Timeframe): number {
        if (timeframe === '1h' || timeframe === '4h') return 60;
        return 900;
    }
}
