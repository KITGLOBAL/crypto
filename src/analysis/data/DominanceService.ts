import { DatabaseService, DominanceSnapshot } from '../../services/DatabaseService';
import { RedisService } from '../../services/RedisService';
import { DominanceAnalysis, MarketContextAnalysis } from '../types';

type MarketSnapshot = {
    btcDominance: number;
    usdtDominance: number;
    totalMarketCapUsd: number;
    createdAt: string;
};

export class DominanceService {
    constructor(
        private redis: RedisService,
        private dbService: DatabaseService
    ) {}

    public async getMarketContext(): Promise<MarketContextAnalysis> {
        const snapshot = await this.redis.getOrFetch<MarketSnapshot>('market_context:coingecko:v1', async () => {
            const headers = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : undefined;
            const [globalRes, tetherRes] = await Promise.all([
                fetch('https://api.coingecko.com/api/v3/global', { headers }),
                fetch('https://api.coingecko.com/api/v3/coins/tether?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false', { headers })
            ]);

            if (!globalRes.ok) {
                throw new Error(`CoinGecko global failed: HTTP ${globalRes.status} ${globalRes.statusText}`);
            }
            if (!tetherRes.ok) {
                throw new Error(`CoinGecko tether failed: HTTP ${tetherRes.status} ${tetherRes.statusText}`);
            }

            const global = await globalRes.json() as any;
            const tether = await tetherRes.json() as any;
            const totalMarketCapUsd = this.finiteNumber(global.data?.total_market_cap?.usd, 0);
            const btcDominance = this.finiteNumber(global.data?.market_cap_percentage?.btc, 0);
            const usdtMarketCap = this.finiteNumber(tether.market_data?.market_cap?.usd, 0);
            const usdtDominance = totalMarketCapUsd > 0 ? (usdtMarketCap / totalMarketCapUsd) * 100 : 0;

            const freshSnapshot = {
                btcDominance,
                usdtDominance,
                totalMarketCapUsd,
                createdAt: new Date().toISOString()
            };

            await this.dbService.saveDominanceSnapshot(freshSnapshot);
            return freshSnapshot;
        }, 1800);

        const [btcHistory, usdtHistory] = await Promise.all([
            this.dbService.getDominanceSnapshots('BTC.D', 30),
            this.dbService.getDominanceSnapshots('USDT.D', 30)
        ]);

        return {
            btcDominance: this.analyzeDominance('BTC.D', snapshot.btcDominance, btcHistory),
            usdtDominance: this.analyzeDominance('USDT.D', snapshot.usdtDominance, usdtHistory),
            totalMarketCapUsd: snapshot.totalMarketCapUsd,
            source: 'CoinGecko Demo + local Mongo snapshots'
        };
    }

    private analyzeDominance(type: 'BTC.D' | 'USDT.D', value: number, history: DominanceSnapshot[]): DominanceAnalysis {
        const safeValue = this.finiteNumber(value, 0);
        const values = history.map(item => this.finiteNumber(item.value, 0)).filter(item => item > 0);
        const positionInRange = this.getPositionInRange(type, safeValue, values);
        const change4h = this.getChange4h(safeValue, history);

        if (values.length < 4) {
            if (type === 'USDT.D') {
                const signalImpact = safeValue >= 7.5 ? 'RISK_OFF' : safeValue <= 5.5 ? 'RISK_ON' : 'NEUTRAL';
                const score = safeValue >= 7.5 ? -6 : safeValue <= 5.5 ? 5 : 0;
                return {
                    value: safeValue,
                    trend: 'RANGE',
                    slope: 'UNKNOWN',
                    change: 0,
                    change4h,
                    positionInRange,
                    breakoutStatus: 'UNKNOWN',
                    signalImpact,
                    impactDescription: `${type} ${positionInRange}; slope pending local history`,
                    score,
                    source: `${type}: current-level fallback, trend pending local history`
                };
            }

            const signalImpact = safeValue <= 53 ? 'RISK_ON' : 'NEUTRAL';
            const score = safeValue >= 60 ? -3 : safeValue <= 53 ? 3 : 0;
            return {
                value: safeValue,
                trend: 'RANGE',
                slope: 'UNKNOWN',
                change: 0,
                change4h,
                positionInRange,
                breakoutStatus: 'UNKNOWN',
                signalImpact,
                impactDescription: `${type} ${positionInRange}; slope pending local history`,
                score,
                source: `${type}: current-level fallback, trend pending local history`
            };
        }

        const first = values[0];
        const last = values[values.length - 1];
        const change = last - first;
        const threshold = type === 'BTC.D' ? 0.25 : 0.12;
        const trend = change > threshold ? 'UP' : change < -threshold ? 'DOWN' : 'RANGE';
        const recent = values.slice(-4);
        const recentChange = recent[recent.length - 1] - recent[0];
        const slopeThreshold = type === 'BTC.D' ? 0.08 : 0.04;
        const slope = recentChange > slopeThreshold ? 'UP' : recentChange < -slopeThreshold ? 'DOWN' : 'FLAT';
        const breakoutStatus = this.getBreakoutStatus(safeValue, values, slope);

        if (type === 'USDT.D') {
            if (trend === 'DOWN') {
                return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, 'RISK_ON', 12, 'USDT market cap / total crypto market cap');
            }
            if (trend === 'UP') {
                return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, 'RISK_OFF', -15, 'USDT market cap / total crypto market cap');
            }
            const rangeScore = slope === 'DOWN' && positionInRange === 'RESISTANCE'
                ? 6
                : slope === 'DOWN'
                    ? 3
                    : slope === 'UP' && positionInRange === 'SUPPORT'
                        ? -6
                        : slope === 'UP'
                            ? -3
                            : 0;
            const impact = rangeScore > 0 ? 'RISK_ON' : rangeScore < 0 ? 'RISK_OFF' : 'NEUTRAL';
            return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, impact, rangeScore, 'USDT market cap / total crypto market cap');
        }

        if (trend === 'DOWN') {
            return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, 'RISK_ON', 6, 'CoinGecko BTC market cap dominance');
        }
        if (trend === 'UP') {
            return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, 'NEUTRAL', -6, 'CoinGecko BTC market cap dominance');
        }
        const rangeScore = slope === 'DOWN' ? 3 : slope === 'UP' ? -3 : 0;
        return this.buildDominanceResult(type, safeValue, trend, slope, change, change4h, positionInRange, breakoutStatus, rangeScore > 0 ? 'RISK_ON' : 'NEUTRAL', rangeScore, 'CoinGecko BTC market cap dominance');
    }

    private buildDominanceResult(
        type: 'BTC.D' | 'USDT.D',
        value: number,
        trend: DominanceAnalysis['trend'],
        slope: DominanceAnalysis['slope'],
        change: number,
        change4h: number,
        positionInRange: DominanceAnalysis['positionInRange'],
        breakoutStatus: DominanceAnalysis['breakoutStatus'],
        signalImpact: DominanceAnalysis['signalImpact'],
        score: number,
        source: string
    ): DominanceAnalysis {
        const slopeText = slope === 'UNKNOWN' ? 'slope unknown' : `slope ${slope}`;
        const positionText = positionInRange === 'UNKNOWN' ? 'range position unknown' : `position ${positionInRange}`;
        const impactDescription = `${type} ${trend}, ${slopeText}, ${positionText}, impact ${signalImpact}`;

        return {
            value,
            trend,
            slope,
            change: Number(change.toFixed(3)),
            change4h: Number(change4h.toFixed(3)),
            positionInRange,
            breakoutStatus,
            signalImpact,
            impactDescription,
            score,
            source
        };
    }

    private getPositionInRange(type: 'BTC.D' | 'USDT.D', value: number, history: number[]): DominanceAnalysis['positionInRange'] {
        if (history.length >= 8) {
            const min = Math.min(...history);
            const max = Math.max(...history);
            const range = max - min;
            if (range <= 0) return 'MID_RANGE';
            const percentile = (value - min) / range;
            if (percentile >= 0.72) return 'RESISTANCE';
            if (percentile <= 0.28) return 'SUPPORT';
            return 'MID_RANGE';
        }

        if (type === 'USDT.D') {
            if (value >= 7.5) return 'RESISTANCE';
            if (value <= 5.5) return 'SUPPORT';
            return 'MID_RANGE';
        }

        if (value >= 60) return 'RESISTANCE';
        if (value <= 53) return 'SUPPORT';
        return 'MID_RANGE';
    }

    private getBreakoutStatus(value: number, history: number[], slope: DominanceAnalysis['slope']): DominanceAnalysis['breakoutStatus'] {
        if (history.length < 8) return 'UNKNOWN';
        const previous = history.slice(0, -1);
        const previousHigh = Math.max(...previous);
        const previousLow = Math.min(...previous);
        if (value > previousHigh && slope === 'UP') return 'BREAKING_UP';
        if (value < previousLow && slope === 'DOWN') return 'BREAKING_DOWN';
        return 'NO_BREAK';
    }

    private getChange4h(value: number, history: DominanceSnapshot[]): number {
        if (history.length < 2) return 0;
        const last = history[history.length - 1];
        const lastTime = last.timestamp instanceof Date ? last.timestamp.getTime() : new Date(last.timestamp).getTime();
        const targetTime = lastTime - 4 * 60 * 60 * 1000;
        const baseline = [...history]
            .filter(item => {
                const timestamp = item.timestamp instanceof Date ? item.timestamp.getTime() : new Date(item.timestamp).getTime();
                return timestamp <= targetTime;
            })
            .at(-1) || history[0];
        return value - this.finiteNumber(baseline.value, 0);
    }

    private finiteNumber(value: unknown, fallback: number): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
}
