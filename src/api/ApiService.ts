import cors from 'cors';
import express, { Request, Response } from 'express';
import { Server } from 'http';
import {
    API_BASIC_AUTH_PASSWORD,
    API_BASIC_AUTH_USER,
    API_CORS_ORIGINS,
    API_PORT,
    API_RATE_LIMIT_MAX,
    API_RATE_LIMIT_WINDOW_MS,
    API_SCHEMA_VERSION,
    ANALYSIS_TOP_SYMBOLS
} from '../config';
import { AnalysisService } from '../analysis/AnalysisService';
import { DatabaseService } from '../services/DatabaseService';
import {
    ActionableSetupDto,
    ActionableSetupDetailDto,
    AlertSettingsDto,
    ApiEnvelope,
    ChartDataDto,
    DashboardAnalysisItemDto,
    HealthDto,
    AnalysisResultDto,
    MarketOverviewDto,
    MarketFiltersTimelineDto,
    SnapshotAnalyticsDto,
    TacticalTimelineDto,
    TacticalSetupDto
} from './dto';
import type { AnalysisResult, AnalysisSnapshot, Candle, SignalOutcome } from '../analysis/types';

export class ApiService {
    private readonly app = express();
    private server?: Server;
    private readonly startedAt = Date.now();
    private readonly rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

    constructor(
        private readonly dbService: DatabaseService,
        private readonly analysisService: AnalysisService
    ) {
        this.configure();
        this.registerRoutes();
    }

    public start(port: number = API_PORT): void {
        this.server = this.app.listen(port, () => {
            console.log(`✅ API server listening on port ${port}.`);
        });
    }

    public async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve, reject) => {
            this.server?.close(error => error ? reject(error) : resolve());
        });
        console.log('✅ API server stopped.');
    }

    private configure(): void {
        this.app.use(cors({
            origin: (origin, callback) => {
                if (!origin || API_CORS_ORIGINS.length === 0 || API_CORS_ORIGINS.includes(origin)) {
                    callback(null, true);
                    return;
                }
                callback(new Error(`CORS blocked for origin ${origin}`));
            }
        }));
        this.app.use(express.json());
        this.app.use((req, res, next) => {
            const key = req.ip || req.socket.remoteAddress || 'unknown';
            const now = Date.now();
            const bucket = this.rateLimitBuckets.get(key);
            if (!bucket || bucket.resetAt <= now) {
                this.rateLimitBuckets.set(key, { count: 1, resetAt: now + API_RATE_LIMIT_WINDOW_MS });
                next();
                return;
            }
            if (bucket.count >= API_RATE_LIMIT_MAX) {
                res.status(429).json({ error: 'Rate limit exceeded' });
                return;
            }
            bucket.count += 1;
            next();
        });
        this.app.use((req, res, next) => {
            if (!API_BASIC_AUTH_USER || !API_BASIC_AUTH_PASSWORD) {
                next();
                return;
            }

            const header = req.headers.authorization || '';
            const [scheme, token] = header.split(' ');
            if (scheme !== 'Basic' || !token) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Crypto Dashboard"');
                res.status(401).json({ error: 'Authentication required' });
                return;
            }

            const [user, password] = Buffer.from(token, 'base64').toString('utf8').split(':');
            if (user !== API_BASIC_AUTH_USER || password !== API_BASIC_AUTH_PASSWORD) {
                res.setHeader('WWW-Authenticate', 'Basic realm="Crypto Dashboard"');
                res.status(401).json({ error: 'Invalid credentials' });
                return;
            }

            next();
        });
    }

    private registerRoutes(): void {
        this.app.get('/api/health', (_req, res) => {
            this.send(res, {
                status: 'ok',
                apiVersion: 'v1',
                schemaVersion: API_SCHEMA_VERSION,
                uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000)
            } satisfies HealthDto);
        });

        this.app.get('/api/symbols', (_req, res) => {
            this.send(res, ANALYSIS_TOP_SYMBOLS);
        });

        this.app.get('/api/analysis', async (req, res) => {
            await this.handle(req, res, async () => {
                const limit = this.parseLimit(req.query.limit, 500);
                const snapshots = await this.dbService.getRecentAnalysisSnapshots(limit);
                const latestBySymbol = new Map<string, DashboardAnalysisItemDto>();
                for (const snapshot of snapshots) {
                    if (latestBySymbol.has(snapshot.symbol)) continue;
                    latestBySymbol.set(snapshot.symbol, this.toDashboardItem(snapshot));
                }
                return ANALYSIS_TOP_SYMBOLS
                    .map(symbol => latestBySymbol.get(symbol))
                    .filter((item): item is DashboardAnalysisItemDto => Boolean(item));
            });
        });

        this.app.get('/api/analysis/:symbol', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = String(req.params.symbol || '').toUpperCase();
                const locale = req.query.locale === 'ru' ? 'ru' : 'en';
                const result = await this.analysisService.analyze(symbol, locale, {
                    persistSignal: false,
                    includeAiSummary: false,
                    updateSignalTracking: false
                });
                return this.toAnalysisDetailDto(result);
            });
        });

        this.app.get('/api/snapshots/:symbol', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = String(req.params.symbol || '').toUpperCase();
                const limit = this.parseLimit(req.query.limit, 200);
                return this.dbService.getAnalysisSnapshots(symbol, limit);
            });
        });

        this.app.get('/api/chart/:symbol', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = String(req.params.symbol || '').toUpperCase();
                const limit = this.parseLimit(req.query.limit, 240);
                const chartTimeframe = req.query.timeframe === '1h' ? '1h' : '4h';
                const [candles, snapshots, setups, lastSignal] = await Promise.all([
                    this.analysisService.getClosedCandles(symbol, chartTimeframe, limit),
                    this.dbService.getAnalysisSnapshots(symbol, 200),
                    this.dbService.getActionableSetups(200),
                    this.dbService.getLastAnalysisSignal(symbol, '4h')
                ]);
                const latest = snapshots[0];
                const activeSetup = setups.find(setup =>
                    setup.symbol === symbol && !['INVALIDATED', 'EXPIRED'].includes(setup.status)
                );
                const raw = lastSignal?.rawAnalysis as any;
                const dynamic = raw?.dynamicReferenceZone as { from?: number; to?: number } | undefined;
                const tactical = latest?.tacticalZoneFrom !== undefined && latest.tacticalZoneTo !== undefined
                    ? { from: latest.tacticalZoneFrom, to: latest.tacticalZoneTo, status: latest.tacticalStatus }
                    : undefined;

                const data: ChartDataDto = {
                    symbol,
                    timeframe: chartTimeframe,
                    candles: candles.map(candle => ({
                        time: Math.floor(candle.openTime / 1000),
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume
                    })),
                    zones: [
                        activeSetup ? {
                            id: activeSetup.setupId,
                            label: `Actionable ${activeSetup.side} ${activeSetup.status}`,
                            from: activeSetup.from,
                            to: activeSetup.to,
                            kind: 'ACTIONABLE',
                            status: activeSetup.status
                        } : undefined,
                        dynamic?.from !== undefined && dynamic?.to !== undefined ? {
                            id: `${symbol}-dynamic-reference`,
                            label: 'Dynamic Reference - informational only',
                            from: Math.min(dynamic.from, dynamic.to),
                            to: Math.max(dynamic.from, dynamic.to),
                            kind: 'DYNAMIC_REFERENCE',
                            informationalOnly: true
                        } : undefined,
                        tactical ? {
                            id: `${symbol}-tactical-${latest?.createdAt.toISOString()}`,
                            label: `Tactical ${latest?.tacticalSide || ''} ${tactical.status}`,
                            from: Math.min(tactical.from, tactical.to),
                            to: Math.max(tactical.from, tactical.to),
                            kind: 'TACTICAL',
                            status: tactical.status
                        } : undefined
                    ].filter(Boolean) as ChartDataDto['zones'],
                    levels: [
                        latest ? { id: `${symbol}-current`, label: 'Current price', price: latest.price, kind: 'CURRENT_PRICE' } : undefined,
                        latest?.nearestSupport ? { id: `${symbol}-support`, label: 'Nearest support', price: latest.nearestSupport, kind: 'SUPPORT' } : undefined,
                        latest?.nearestResistance ? { id: `${symbol}-resistance`, label: 'Nearest resistance', price: latest.nearestResistance, kind: 'RESISTANCE' } : undefined,
                        latest?.longActivationLevel ? { id: `${symbol}-long-activation`, label: 'Long activation', price: latest.longActivationLevel, kind: 'ACTIVATION_LONG' } : undefined,
                        latest?.shortActivationLevel ? { id: `${symbol}-short-activation`, label: 'Short activation', price: latest.shortActivationLevel, kind: 'ACTIVATION_SHORT' } : undefined,
                        activeSetup?.stopLoss ? { id: `${symbol}-invalidation`, label: 'Invalidation / stop', price: activeSetup.stopLoss, kind: 'INVALIDATION' } : undefined
                    ].filter(Boolean) as ChartDataDto['levels'],
                    markers: snapshots.slice(0, 80).map(snapshot => this.toChartMarker(snapshot)).reverse(),
                    panes: this.toChartPanes(candles, snapshots),
                    updatedAt: new Date().toISOString()
                };
                return data;
            });
        });

        this.app.get('/api/analytics/snapshots', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined;
                const limit = this.parseLimit(req.query.limit, 1000);
                const [snapshots, signals] = await Promise.all([
                    symbol ? this.dbService.getAnalysisSnapshots(symbol, limit) : this.dbService.getRecentAnalysisSnapshots(limit),
                    symbol ? this.dbService.getAnalysisSignalHistory(symbol, limit) : this.dbService.getRecentAnalysisSignals(limit)
                ]);
                return this.buildSnapshotAnalytics(snapshots, signals, symbol);
            });
        });

        this.app.get('/api/actionable-setups', async (req, res) => {
            await this.handle(req, res, async () => {
                const limit = this.parseLimit(req.query.limit, 100);
                const setups = await this.dbService.getActionableSetups(limit);
                return setups.map(setup => this.toActionableSetupDto(setup));
            });
        });

        this.app.get('/api/actionable-setups/:setupId', async (req, res) => {
            await this.handle(req, res, async () => {
                const setupId = String(req.params.setupId || '');
                const setup = await this.dbService.getActionableSetupById(setupId);
                if (!setup) {
                    res.status(404);
                    return { setup: null, timeline: [] };
                }
                const events = await this.dbService.getActionableSetupEvents(setupId, 300);
                const snapshots = events.length ? [] : await this.dbService.getAnalysisSnapshotsByActionableSetupId(setupId, 300);
                return {
                    setup: this.toActionableSetupDto(setup),
                    timeline: events.length
                        ? events.reverse().map(event => ({
                            timestamp: event.createdAt.toISOString(),
                            price: event.currentPrice,
                            status: event.status,
                            previousStatus: event.previousStatus,
                            rr: event.riskReward,
                            tradable: event.tradable,
                            reason: event.reason
                        }))
                        : snapshots.reverse().map(snapshot => ({
                            timestamp: snapshot.createdAt.toISOString(),
                            price: snapshot.price,
                            status: snapshot.actionableEntryZoneStatus,
                            rr: snapshot.actionableEntryZoneRr,
                            tradable: snapshot.actionableEntryZoneTradable,
                            notTradableReason: snapshot.actionableEntryZoneNotTradableReason,
                            tacticalStatus: snapshot.tacticalStatus,
                            tacticalSide: snapshot.tacticalSide
                        }))
                } satisfies ActionableSetupDetailDto;
            });
        });

        this.app.get('/api/tactical-setups', async (req, res) => {
            await this.handle(req, res, async () => {
                const limit = this.parseLimit(req.query.limit, 500);
                const snapshots = await this.dbService.getRecentAnalysisSnapshots(limit);
                const latestBySymbol = new Map<string, TacticalSetupDto>();
                for (const snapshot of snapshots) {
                    if (latestBySymbol.has(snapshot.symbol)) continue;
                    latestBySymbol.set(snapshot.symbol, {
                        symbol: snapshot.symbol,
                        status: snapshot.tacticalStatus,
                        side: snapshot.tacticalSide,
                        zoneFrom: snapshot.tacticalZoneFrom,
                        zoneTo: snapshot.tacticalZoneTo,
                        rr: snapshot.tacticalRR,
                        stop: snapshot.tacticalStop,
                        requiredEntryForMinRr: snapshot.tacticalRequiredEntryForMinRr,
                        zoneStatus: snapshot.tacticalZoneStatus,
                        reason: snapshot.tacticalReason,
                        updatedAt: snapshot.createdAt.toISOString()
                    });
                }
                return Array.from(latestBySymbol.values());
            });
        });

        this.app.get('/api/tactical-setups/:symbol/timeline', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = String(req.params.symbol || '').toUpperCase();
                const limit = this.parseLimit(req.query.limit, 200);
                const events = await this.dbService.getTacticalSetupEvents(symbol, limit);
                if (events.length) {
                    return {
                        symbol,
                        timeline: events.reverse().map(event => ({
                            timestamp: event.createdAt.toISOString(),
                            status: event.status,
                            previousStatus: event.previousStatus,
                            side: event.side,
                            rr: event.rr,
                            stop: event.stop,
                            zoneFrom: event.zoneFrom,
                            zoneTo: event.zoneTo,
                            zoneStatus: event.zoneStatus,
                            reason: event.reason,
                            confirmations: {
                                inZone: event.status === 'IN_ZONE' || event.status === 'CONFIRMATION_PENDING' || event.status === 'CONFIRMED',
                                rrOk: (event.rr || 0) >= 1.8,
                                cvdOk: true,
                                tacticalConfirmed: event.status === 'CONFIRMED'
                            }
                        }))
                    } satisfies TacticalTimelineDto;
                }
                const snapshots = await this.dbService.getAnalysisSnapshots(symbol, limit);
                return {
                    symbol,
                    timeline: snapshots.reverse().map(snapshot => ({
                        timestamp: snapshot.createdAt.toISOString(),
                        status: snapshot.tacticalStatus,
                        side: snapshot.tacticalSide,
                        rr: snapshot.tacticalRR,
                        stop: snapshot.tacticalStop,
                        zoneFrom: snapshot.tacticalZoneFrom,
                        zoneTo: snapshot.tacticalZoneTo,
                        zoneStatus: snapshot.tacticalZoneStatus,
                        reason: snapshot.tacticalReason,
                        confirmations: {
                            inZone: snapshot.tacticalStatus === 'IN_ZONE' || snapshot.tacticalStatus === 'CONFIRMATION_PENDING' || snapshot.tacticalStatus === 'CONFIRMED',
                            rrOk: (snapshot.tacticalRR || 0) >= 1.8,
                            cvdOk: snapshot.tacticalSide === 'SHORT' ? snapshot.cvdTrend !== 'UP' : snapshot.cvdTrend !== 'DOWN',
                            tacticalConfirmed: snapshot.tacticalStatus === 'CONFIRMED'
                        }
                    }))
                } satisfies TacticalTimelineDto;
            });
        });

        this.app.get('/api/market/overview', async (_req, res) => {
            await this.handle(_req, res, async () => {
                const [btcD, usdtD, total] = await Promise.all([
                    this.dbService.getDominanceSnapshots('BTC.D', 1),
                    this.dbService.getDominanceSnapshots('USDT.D', 1),
                    this.dbService.getDominanceSnapshots('TOTAL', 1)
                ]);
                return {
                    btcDominance: btcD[0] ? { value: btcD[0].value, updatedAt: btcD[0].timestamp.toISOString() } : undefined,
                    usdtDominance: usdtD[0] ? { value: usdtD[0].value, updatedAt: usdtD[0].timestamp.toISOString() } : undefined,
                    totalMarketCapUsd: total[0] ? { value: total[0].value, updatedAt: total[0].timestamp.toISOString() } : undefined
                } satisfies MarketOverviewDto;
            });
        });

        this.app.get('/api/market/filters/:symbol', async (req, res) => {
            await this.handle(req, res, async () => {
                const symbol = String(req.params.symbol || '').toUpperCase();
                const limit = this.parseLimit(req.query.limit, 200);
                const snapshots = await this.dbService.getAnalysisSnapshots(symbol, limit);
                return {
                    symbol,
                    timeline: snapshots.reverse().map(snapshot => ({
                        timestamp: snapshot.createdAt.toISOString(),
                        price: snapshot.price,
                        btcDominanceValue: snapshot.btcDominanceValue,
                        btcDominanceTrend: snapshot.btcDominanceTrend,
                        btcDominanceSlope: snapshot.btcDominanceSlope,
                        btcDominanceChange4h: snapshot.btcDominanceChange4h,
                        btcDominanceImpact: snapshot.btcDominanceImpact,
                        usdtDominanceValue: snapshot.usdtDominanceValue,
                        usdtDominanceTrend: snapshot.usdtDominanceTrend,
                        usdtDominanceSlope: snapshot.usdtDominanceSlope,
                        usdtDominanceChange4h: snapshot.usdtDominanceChange4h,
                        usdtDominanceImpact: snapshot.usdtDominanceImpact,
                        btcTrend: snapshot.weeklyTrend,
                        btcH4Trend: snapshot.h4Structure
                    }))
                } satisfies MarketFiltersTimelineDto;
            });
        });

        this.app.get('/api/alert-settings', async (req, res) => {
            await this.handle(req, res, async () => this.toAlertSettingsDto(await this.dbService.getDashboardAlertSettings()));
        });

        this.app.patch('/api/alert-settings', this.requireWriteAuth.bind(this), async (req, res) => {
            await this.handle(req, res, async () => this.toAlertSettingsDto(await this.dbService.updateDashboardAlertSettings(req.body || {})));
        });
    }

    private requireWriteAuth(_req: Request, res: Response, next: () => void): void {
        if (!API_BASIC_AUTH_USER || !API_BASIC_AUTH_PASSWORD) {
            res.status(403).json({
                apiVersion: 'v1',
                schemaVersion: API_SCHEMA_VERSION,
                error: 'Write endpoints are disabled until API_BASIC_AUTH_USER/PASSWORD are configured.'
            });
            return;
        }
        next();
    }

    private async handle<T>(req: Request, res: Response, fn: () => Promise<T>): Promise<void> {
        try {
            this.send(res, await fn());
        } catch (error: any) {
            console.error(`API ${req.method} ${req.path} failed:`, error);
            res.status(500).json({
                apiVersion: 'v1',
                schemaVersion: API_SCHEMA_VERSION,
                error: error.message || 'Internal server error'
            });
        }
    }

    private send<T>(res: Response, data: T): void {
        const envelope: ApiEnvelope<T> = {
            apiVersion: 'v1',
            schemaVersion: API_SCHEMA_VERSION,
            data
        };
        res.json(envelope);
    }

    private toAnalysisDetailDto(result: AnalysisResult): AnalysisResultDto {
        return {
            symbol: result.symbol,
            timeframe: result.timeframe,
            mainSetup: {
                decision: result.decision,
                primaryScenario: result.primaryScenario,
                bias: result.bias,
                directionScore: result.directionScore,
                setupQuality: result.setupQuality,
                setupQualityScore: result.setupQualityScore,
                riskScore: result.riskScore,
                tradeConfidence: result.tradeConfidence,
                mainReason: result.mainReason,
                currentAction: result.currentAction,
                whyNotNow: result.whyNotNow
            },
            price: {
                current: result.entry.currentPrice,
                updatedAt: result.createdAt
            },
            marketState: result.marketState,
            dynamicReferenceZone: result.dynamicReferenceZone,
            actionableEntryZone: result.actionableEntryZone,
            activationLevels: result.activationLevels,
            tacticalSetup: result.tacticalSetup,
            riskManagement: result.riskManagement,
            context: result.analysis,
            scoreBreakdown: result.categoryScores,
            reasoning: result.reasoning,
            warnings: result.warnings,
            scenarios: result.nextConditions,
            summary: result.aiSummary || result.reasonForDecision,
            strategyVersion: result.strategyVersion,
            schemaVersion: API_SCHEMA_VERSION
        };
    }

    private toAlertSettingsDto(settings: Awaited<ReturnType<DatabaseService['getDashboardAlertSettings']>>): AlertSettingsDto {
        return {
            id: settings.id,
            mainDecisionChanges: settings.mainDecisionChanges,
            actionableInZone: settings.actionableInZone,
            tacticalConfirmed: settings.tacticalConfirmed,
            marketFilterConflict: settings.marketFilterConflict,
            minRiskReward: settings.minRiskReward,
            updatedAt: settings.updatedAt.toISOString()
        };
    }

    private toActionableSetupDto(setup: Awaited<ReturnType<DatabaseService['getActionableSetups']>>[number]): ActionableSetupDto {
        return {
            setupId: setup.setupId,
            symbol: setup.symbol,
            timeframe: setup.timeframe,
            side: setup.side,
            from: setup.from,
            to: setup.to,
            source: setup.source,
            status: setup.status,
            currentPrice: setup.currentPrice,
            requiredEntryForMinRr: setup.requiredEntryForMinRr,
            riskReward: setup.riskReward,
            stopLoss: setup.stopLoss,
            target: setup.target,
            invalidation: setup.invalidation,
            replacedBySetupId: setup.replacedBySetupId,
            expiredReason: setup.expiredReason,
            createdAtCandleTime: setup.createdAtCandleTime,
            createdAt: setup.createdAt.toISOString(),
            updatedAt: setup.updatedAt.toISOString(),
            expiresAt: setup.expiresAt.toISOString()
        };
    }

    private parseLimit(value: unknown, fallback: number): number {
        const raw = Array.isArray(value) ? value[0] : value;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
        return Math.min(Math.floor(parsed), 1000);
    }

    private toChartPanes(candles: Candle[], snapshots: AnalysisSnapshot[]): ChartDataDto['panes'] {
        const sortedSnapshots = [...snapshots].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return {
            volume: candles.map(candle => ({
                time: Math.floor(candle.openTime / 1000),
                value: candle.volume
            })),
            orderFlow: sortedSnapshots.map(snapshot => ({
                time: Math.floor(snapshot.createdAt.getTime() / 1000),
                deltaRatio: snapshot.deltaRatio,
                cvdTrend: snapshot.cvdTrend
            })),
            derivatives: sortedSnapshots.map(snapshot => ({
                time: Math.floor(snapshot.createdAt.getTime() / 1000),
                fundingRate: snapshot.fundingRate,
                fundingRank: snapshot.fundingPercentile30d,
                oiChange4h: snapshot.oiChange4h,
                oiChange24h: snapshot.oiChange24h,
                oiChange7d: snapshot.oiChange7d
            })),
            marketFilters: sortedSnapshots.map(snapshot => ({
                time: Math.floor(snapshot.createdAt.getTime() / 1000),
                btcDominance: snapshot.btcDominanceValue,
                usdtDominance: snapshot.usdtDominanceValue,
                btcDominanceChange4h: snapshot.btcDominanceChange4h,
                usdtDominanceChange4h: snapshot.usdtDominanceChange4h
            }))
        };
    }

    private toChartMarker(snapshot: AnalysisSnapshot): ChartDataDto['markers'][number] {
        const hasTactical = snapshot.tacticalStatus === 'CONFIRMED';
        const actionable = snapshot.actionableEntryZoneStatus;
        const decisionColor = snapshot.decision === 'LONG'
            ? '#22c55e'
            : snapshot.decision === 'SHORT'
                ? '#ef4444'
                : '#f59e0b';

        return {
            time: Math.floor(snapshot.createdAt.getTime() / 1000),
            position: snapshot.decision === 'SHORT' ? 'aboveBar' : 'belowBar',
            color: hasTactical ? '#38bdf8' : decisionColor,
            shape: snapshot.decision === 'LONG' || snapshot.primaryScenario === 'LONG' ? 'arrowUp' : snapshot.primaryScenario === 'SHORT' ? 'arrowDown' : 'circle',
            text: hasTactical
                ? `Tactical ${snapshot.tacticalSide} confirmed`
                : actionable
                    ? `${snapshot.decision} / ${actionable}`
                    : snapshot.decision
        };
    }

    private buildSnapshotAnalytics(
        snapshots: AnalysisSnapshot[],
        signals: Awaited<ReturnType<DatabaseService['getRecentAnalysisSignals']>>,
        symbol?: string
    ): SnapshotAnalyticsDto {
        const sorted = [...snapshots].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const waitReasons = new Map<string, number>();
        const chaseOutcomes = new Map<string, number>();
        const tacticalFunnel = new Map<string, number>();
        const actionableLifecycle = new Map<string, number>();
        const transitions = new Map<string, number>();
        let missedThenContinued = 0;
        let inZoneThenTacticalConfirmed = 0;
        let chaseSamples = 0;

        sorted.forEach((snapshot, index) => {
            if (snapshot.decision === 'WAIT') {
                this.increment(waitReasons, snapshot.primaryScenario === 'NEUTRAL' ? 'NO_DIRECTIONAL_EDGE' : 'NO_ACTIVE_4H_SETUP');
                if (snapshot.riskReward !== undefined && snapshot.riskReward < 1.8) this.increment(waitReasons, 'RR_BELOW_MINIMUM');
                if (snapshot.setupQuality === 'CHASE') this.increment(waitReasons, 'ENTRY_CHASE');
                if (snapshot.actionableEntryZoneStatus === 'MISSED') this.increment(waitReasons, 'ACTIONABLE_MISSED');
                if (snapshot.tacticalStatus === 'DISABLED') this.increment(waitReasons, 'TACTICAL_DISABLED');
            }

            if (snapshot.setupQuality === 'CHASE') {
                chaseSamples += 1;
                const next = sorted[index + 1];
                if (!next) this.increment(chaseOutcomes, 'OPEN_SAMPLE');
                else if (next.price > snapshot.price * 1.01) this.increment(chaseOutcomes, 'CONTINUED_UP_1PCT');
                else if (next.price < snapshot.price * 0.99) this.increment(chaseOutcomes, 'REVERTED_DOWN_1PCT');
                else this.increment(chaseOutcomes, 'SIDEWAYS_NEXT_SNAPSHOT');
            }

            if (snapshot.actionableEntryZoneStatus === 'MISSED') {
                const next = sorted.slice(index + 1, index + 4).find(item => item.symbol === snapshot.symbol);
                const continuedLong = snapshot.primaryScenario === 'LONG' && next && next.price > snapshot.price * 1.01;
                const continuedShort = snapshot.primaryScenario === 'SHORT' && next && next.price < snapshot.price * 0.99;
                if (continuedLong || continuedShort) missedThenContinued += 1;
            }

            if (snapshot.actionableEntryZoneStatus === 'IN_ZONE') {
                const confirmed = sorted.slice(index + 1, index + 4).some(item =>
                    item.symbol === snapshot.symbol && item.tacticalStatus === 'CONFIRMED'
                );
                if (confirmed) inZoneThenTacticalConfirmed += 1;
            }

            this.increment(tacticalFunnel, snapshot.tacticalStatus);
            if (snapshot.actionableEntryZoneStatus) this.increment(actionableLifecycle, snapshot.actionableEntryZoneStatus);

            const prev = sorted[index - 1];
            if (prev?.actionableEntryZoneStatus && snapshot.actionableEntryZoneStatus && prev.actionableEntryZoneStatus !== snapshot.actionableEntryZoneStatus) {
                this.increment(transitions, `${prev.actionableEntryZoneStatus}->${snapshot.actionableEntryZoneStatus}`);
            }
        });

        return {
            symbol,
            waitReasons: this.mapToRows(waitReasons, 'reason'),
            chaseOutcomes: this.mapToRows(chaseOutcomes, 'bucket'),
            tacticalFunnel: this.mapToRows(tacticalFunnel, 'status'),
            actionableLifecycle: this.mapToRows(actionableLifecycle, 'status'),
            setupTransitions: Array.from(transitions.entries()).map(([key, count]) => {
                const [from, to] = key.split('->');
                return { from, to, count };
            }),
            signalOutcomes: this.buildSignalOutcomeAnalytics(signals),
            lifecycleQuality: {
                missedThenContinued,
                inZoneThenTacticalConfirmed,
                chaseSamples
            }
        };
    }

    private buildSignalOutcomeAnalytics(signals: Awaited<ReturnType<DatabaseService['getRecentAnalysisSignals']>>): SnapshotAnalyticsDto['signalOutcomes'] {
        const outcomes = signals
            .map(signal => signal.signalOutcome)
            .filter((outcome): outcome is SignalOutcome => Boolean(outcome));
        const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
        const avg = (values: number[]) => values.length ? sum(values) / values.length : 0;
        const timeToTP1 = outcomes.map(item => item.timeToTP1Hours).filter((value): value is number => value !== undefined);
        const timeToSL = outcomes.map(item => item.timeToSLHours).filter((value): value is number => value !== undefined);

        return {
            totalSignals: outcomes.length,
            tp1: outcomes.filter(item => item.hitTP1 || item.status === 'TP1' || item.status === 'TP2' || item.status === 'TP3').length,
            tp2: outcomes.filter(item => item.hitTP2 || item.status === 'TP2' || item.status === 'TP3').length,
            sl: outcomes.filter(item => item.hitSL || item.status === 'SL').length,
            open: outcomes.filter(item => item.status === 'OPEN').length,
            expired: outcomes.filter(item => item.status === 'EXPIRED').length,
            avgMfePct: Number(avg(outcomes.map(item => item.maxFavorableExcursionPct)).toFixed(2)),
            avgMaePct: Number(avg(outcomes.map(item => item.maxAdverseExcursionPct)).toFixed(2)),
            avgTimeToTP1Hours: timeToTP1.length ? Number(avg(timeToTP1).toFixed(2)) : undefined,
            avgTimeToSLHours: timeToSL.length ? Number(avg(timeToSL).toFixed(2)) : undefined
        };
    }

    private increment(map: Map<string, number>, key: string): void {
        map.set(key, (map.get(key) || 0) + 1);
    }

    private mapToRows<K extends string>(map: Map<string, number>, key: K): Array<Record<K, string> & { count: number }> {
        return Array.from(map.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([label, count]) => ({ [key]: label, count } as Record<K, string> & { count: number }));
    }

    private toDashboardItem(snapshot: Awaited<ReturnType<DatabaseService['getRecentAnalysisSnapshots']>>[number]): DashboardAnalysisItemDto {
        return {
            symbol: snapshot.symbol,
            price: snapshot.price,
            mainDecision: snapshot.decision,
            primaryScenario: snapshot.primaryScenario,
            bias: snapshot.bias,
            directionScore: snapshot.directionScore,
            setupQuality: snapshot.setupQuality,
            setupQualityScore: snapshot.setupQualityScore,
            riskScore: snapshot.riskScore,
            riskReward: snapshot.riskReward,
            actionableStatus: snapshot.actionableEntryZoneStatus,
            actionableTradable: snapshot.actionableEntryZoneTradable,
            actionableSetupId: snapshot.actionableEntryZoneSetupId,
            tacticalStatus: snapshot.tacticalStatus,
            tacticalSide: snapshot.tacticalSide,
            tacticalRR: snapshot.tacticalRR,
            volumeRatio: snapshot.volumeRatio,
            cvdTrend: snapshot.cvdTrend,
            deltaRatio: snapshot.deltaRatio,
            fundingRate: snapshot.fundingRate,
            fundingPercentile30d: snapshot.fundingPercentile30d,
            oiChange24h: snapshot.oiChange24h,
            oiChange7d: snapshot.oiChange7d,
            updatedAt: snapshot.createdAt.toISOString()
        };
    }
}
