// src/services/MarketDataService.ts

import { RedisService } from './RedisService';

export interface ExchangeData {
    name: string;
    price: number;
    fundingRate: number;
    nextFundingTime: number;
    openInterest: number;
    url: string;
}

export interface AggregatedStats {
    symbol: string;
    totalOpenInterest: number;
    avgPrice: number;
    exchanges: ExchangeData[];
    timestamp: number;
}

export interface OISurge {
    symbol: string;
    previousOI: number;
    currentOI: number;
    percentChange: number;
    price: number;
    priceChangePercent: number;
}

export interface AssetStats {
    symbol: string;
    price: number;
    fundingRate: number;
    openInterest: number;
    longShortRatio: number;
}

export interface FundingHistoryPoint {
    fundingTime: number;
    fundingRate: number;
}

export interface OpenInterestHistoryPoint {
    timestamp: number;
    openInterestUsd: number;
}

interface FundingItem {
    symbol: string;
    exchange: string;
    rate: number;
}

function safeFloat(val: any): number {
    if (val === null || val === undefined || val === '') return 0;
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
}

export class MarketDataService {
    private redis: RedisService;
    private readonly binanceBaseUrl = 'https://fapi.binance.com';

    // Заголовки, чтобы Binance не блокировал запросы
    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    constructor(redis: RedisService) {
        this.redis = redis;
        console.log('✅ MarketDataService initialized (Endpoint Fixed).');
    }

    private normalizeSymbol(input: string): string {
        return input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
    }

    private async fetchJson(url: string): Promise<any> {
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText} at ${url}`);
        }
        return await res.json();
    }

    public async getAggregatedStats(symbolInput: string): Promise<AggregatedStats | null> {
        const baseSymbol = this.normalizeSymbol(symbolInput);
        const cacheKey = `market_agg_v6:${baseSymbol}`;

        // Раскомментируй кэш для продакшена (30-60 сек)
        // return this.redis.getOrFetch<AggregatedStats | null>(cacheKey, async () => {
        
        console.log(`🔍 [${baseSymbol}] Fetching exchanges...`);

        const results = await Promise.allSettled([
            this.fetchBinance(baseSymbol),
            this.fetchBybit(baseSymbol),
            this.fetchMexc(baseSymbol)
        ]);

        const exchanges: ExchangeData[] = [];
        
        results.forEach((res, i) => {
            const names = ['Binance', 'Bybit', 'MEXC'];
            if (res.status === 'fulfilled' && res.value) {
                exchanges.push(res.value);
            } else if (res.status === 'rejected') {
                console.error(`❌ [${names[i]}] Failed:`, res.reason.message);
            }
        });

        if (exchanges.length === 0) return null;

        const totalOI = exchanges.reduce((sum, ex) => sum + ex.openInterest, 0);
        const avgPrice = exchanges.reduce((sum, ex) => sum + ex.price, 0) / exchanges.length;
        
        exchanges.sort((a, b) => b.openInterest - a.openInterest);

        const stats = {
            symbol: baseSymbol,
            totalOpenInterest: totalOI,
            avgPrice,
            exchanges,
            timestamp: Date.now()
        };

        await this.redis.set(cacheKey, stats, 60);
        return stats;
        // }, 60);
    }

    // --- FETCHERS ---

    private async fetchBinance(base: string): Promise<ExchangeData | null> {
         const s = `${base}USDT`;
         try {
            const [premium, oi, ticker] = await Promise.all([
                this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/premiumIndex?symbol=${s}`),
                this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/openInterest?symbol=${s}`),
                this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/ticker/price?symbol=${s}`)
            ]);
            
            if (!premium.symbol) return null;
            const price = safeFloat(ticker.price);
            
            return {
                name: 'Binance 🔶', 
                price: price, 
                fundingRate: safeFloat(premium.lastFundingRate),
                nextFundingTime: premium.nextFundingTime, 
                openInterest: safeFloat(oi.openInterest) * price, 
                url: `https://www.binance.com/en/futures/${s}`
            };
        } catch (e) { return null; }
    }

    private async fetchBybit(base: string): Promise<ExchangeData | null> { 
        const s = `${base}USDT`;
        try {
            const res = await this.fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`);
            if (res.retCode !== 0) return null;
            const t = res.result.list[0];
            const price = safeFloat(t.lastPrice);
            const oiSize = safeFloat(t.openInterest); 
            return {
                name: 'Bybit ⚫️', 
                price: price, 
                fundingRate: safeFloat(t.fundingRate),
                nextFundingTime: parseInt(t.nextFundingTime), 
                openInterest: oiSize * price,
                url: `https://www.bybit.com/trade/usdt/${s}`
            };
        } catch (e) { return null; }
    }

    private async fetchMexc(base: string): Promise<ExchangeData | null> {
        const s = `${base}_USDT`;
        try {
            const [tickerRes, fundingRes, detailRes] = await Promise.all([
                this.fetchJson(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${s}`),
                this.fetchJson(`https://contract.mexc.com/api/v1/contract/funding_rate/${s}`),
                this.getMexcContractSize(s)
            ]);
            if (!tickerRes.success) return null;
            const price = safeFloat(tickerRes.data.lastPrice);
            const contracts = safeFloat(tickerRes.data.holdVol);
            const contractSize = detailRes; 
            const oiUSD = contracts * contractSize * price;
            return {
                name: 'MEXC 🔵', 
                price: price, 
                fundingRate: safeFloat(fundingRes.data?.fundingRate),
                nextFundingTime: fundingRes.data?.nextFundingTime, 
                openInterest: oiUSD, 
                url: `https://futures.mexc.com/exchange/${s}`
            };
        } catch (e) { return null; }
    }

    private async getMexcContractSize(symbol: string): Promise<number> {
        const cacheKey = `mexc_size:${symbol}`;
        return this.redis.getOrFetch<number>(cacheKey, async () => {
            try {
                const res = await this.fetchJson(`https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`);
                if(res.success && res.data) return safeFloat(res.data.contractSize);
                return 0.0001; 
            } catch { return 1; }
        }, 86400);
    }

    // --- UTILS ---

    public async checkOIFluctuations(symbols: string[]): Promise<OISurge[]> {
        const surges: OISurge[] = [];
        const THRESHOLD = 3.0; 
        
        console.log(`🔎 [OI Monitor] Checking ${symbols.length} pairs (Hourly)...`);

        for (const sym of symbols) {
            const stats = await this.getAggregatedStats(sym);
            if (!stats) continue;

            const keyOI = `oi_last_h:${stats.symbol}`;
            const keyPrice = `price_last_h:${stats.symbol}`;

            const lastOI = await this.redis.get<number>(keyOI);
            const lastPrice = await this.redis.get<number>(keyPrice);

            await this.redis.set(keyOI, stats.totalOpenInterest, 90000);
            await this.redis.set(keyPrice, stats.avgPrice, 90000);

            if (lastOI && lastPrice) {
                const oiChange = ((stats.totalOpenInterest - lastOI) / lastOI) * 100;
                const priceChange = ((stats.avgPrice - lastPrice) / lastPrice) * 100;

                if (Math.abs(oiChange) > 1) {
                    console.log(`ℹ️ ${sym}: OI ${oiChange.toFixed(2)}%, Price ${priceChange.toFixed(2)}%`);
                }

                if (Math.abs(oiChange) >= THRESHOLD) {
                    surges.push({
                        symbol: stats.symbol,
                        previousOI: lastOI,
                        currentOI: stats.totalOpenInterest,
                        percentChange: oiChange,
                        price: stats.avgPrice,
                        priceChangePercent: priceChange
                    });
                }
            }
        }
        return surges;
    }

    // 👇 ФИКС: Используем endpoint /futures/data/ для статистики
    public async getAssetStats(symbol: string): Promise<AssetStats | null> {
        const s = `${this.normalizeSymbol(symbol)}USDT`;
        
        // v3 чтобы сбросить старые ошибки
        return this.redis.getOrFetch<AssetStats | null>(`stats_binance_v3:${s}`, async () => {
            try {
                // ВАЖНО: Разные эндпоинты
                // 1. Стандартные данные: /fapi/v1/
                // 2. Статистика (Ratio): /futures/data/
                
                const [prem, oi, ratio, tick] = await Promise.all([
                    this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/premiumIndex?symbol=${s}`),
                    this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/openInterest?symbol=${s}`),
                    // ИСПРАВЛЕННЫЙ URL ДЛЯ RATIO:
                    this.fetchJson(`${this.binanceBaseUrl}/futures/data/topLongShortAccountRatio?symbol=${s}&period=5m&limit=1`),
                    this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/ticker/price?symbol=${s}`)
                ]);

                if(!prem.symbol) return null;

                const p = safeFloat(tick.price);
                const lsRatio = ratio && ratio.length > 0 ? safeFloat(ratio[0].longShortRatio) : 0;

                return {
                    symbol: s, 
                    price: p, 
                    fundingRate: safeFloat(prem.lastFundingRate),
                    openInterest: safeFloat(oi.openInterest) * p, 
                    longShortRatio: lsRatio
                };
            } catch(e: any) { 
                console.error(`❌ Error fetching stats for ${s}:`, e.message);
                return null; 
            }
        }, 120);
    }

    public async getFundingHistory(symbol: string, limit: number = 90): Promise<FundingHistoryPoint[]> {
        const s = `${this.normalizeSymbol(symbol)}USDT`;
        return this.redis.getOrFetch<FundingHistoryPoint[]>(`funding_history_v1:${s}:${limit}`, async () => {
            try {
                const data = await this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/fundingRate?symbol=${s}&limit=${limit}`);
                if (!Array.isArray(data)) return [];
                return data
                    .map((item: any) => ({
                        fundingTime: Number(item.fundingTime || 0),
                        fundingRate: safeFloat(item.fundingRate)
                    }))
                    .filter((item: FundingHistoryPoint) => item.fundingTime > 0);
            } catch (e: any) {
                console.error(`❌ Error fetching funding history for ${s}:`, e.message);
                return [];
            }
        }, 1800);
    }

    public async getOpenInterestHistory(symbol: string, period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '4h', limit: number = 60): Promise<OpenInterestHistoryPoint[]> {
        const s = `${this.normalizeSymbol(symbol)}USDT`;
        return this.redis.getOrFetch<OpenInterestHistoryPoint[]>(`oi_history_v1:${s}:${period}:${limit}`, async () => {
            try {
                const data = await this.fetchJson(`${this.binanceBaseUrl}/futures/data/openInterestHist?symbol=${s}&period=${period}&limit=${limit}`);
                if (!Array.isArray(data)) return [];
                return data
                    .map((item: any) => ({
                        timestamp: Number(item.timestamp || 0),
                        openInterestUsd: safeFloat(item.sumOpenInterestValue)
                    }))
                    .filter((item: OpenInterestHistoryPoint) => item.timestamp > 0 && item.openInterestUsd > 0);
            } catch (e: any) {
                console.error(`❌ Error fetching OI history for ${s}:`, e.message);
                return [];
            }
        }, 900);
    }

    public async getTopFundingRates(limit: number = 5): Promise<{ high: FundingItem[], low: FundingItem[] }> {
        return this.redis.getOrFetch('funding:global_top_v6', async () => {
            const all: FundingItem[] = [];
            try {
                const d = await this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/premiumIndex`);
                d.forEach((x: any) => { if(x.symbol.endsWith('USDT')) all.push({ symbol: x.symbol, exchange: 'Binance', rate: safeFloat(x.lastFundingRate) }); });
            } catch(e) {}
            try {
                const d = await this.fetchJson('https://api.bybit.com/v5/market/tickers?category=linear');
                if(d.retCode === 0) d.result.list.forEach((x: any) => { if(x.symbol.endsWith('USDT')) all.push({ symbol: x.symbol, exchange: 'Bybit', rate: safeFloat(x.fundingRate) }); });
            } catch(e) {}

            all.sort((a, b) => b.rate - a.rate);
            return { high: all.slice(0, limit), low: all.slice(-limit).reverse() };
        }, 300);
    }

    public async getFundingMap(symbols: string[]): Promise<Map<string, number>> {
        const d = await this.fetchJson(`${this.binanceBaseUrl}/fapi/v1/premiumIndex`);
        const m = new Map<string, number>();
        const set = new Set(symbols);
        d.forEach((x: any) => { if(set.has(x.symbol)) m.set(x.symbol, safeFloat(x.lastFundingRate)); });
        return m;
    }
}
