import { ANALYSIS_AI_MODEL, ANALYSIS_AI_SUMMARY_ENABLED, ANALYSIS_TOP_SYMBOLS, OPENAI_API_KEY } from '../config';
import { ActionableEntryZone, AnalysisResult, AnalysisSnapshot, Candle, DerivativesAnalysis, RetestAnalysis, RiskManagementPlan, SetupExpirationReason, SignalOutcome, TacticalSetup, Timeframe } from './types';
import { CandleService } from './data/CandleService';
import { DominanceService } from './data/DominanceService';
import { DerivativesService } from './data/DerivativesService';
import { TechnicalAnalyzers } from './analyzers/TechnicalAnalyzers';
import { OrderFlowAnalyzer } from './analyzers/OrderFlowAnalyzer';
import { ScoringEngine } from './analyzers/ScoringEngine';
import { TacticalEntryAnalyzer } from './analyzers/TacticalEntryAnalyzer';
import { ActionableSetupEventReason, ActionableSetupRecord, DatabaseService } from '../services/DatabaseService';
import { RedisService } from '../services/RedisService';
import { MarketDataService } from '../services/MarketDataService';

export class AnalysisService {
    private candleService: CandleService;
    private dominanceService: DominanceService;
    private derivativesService: DerivativesService;
    private technicalAnalyzers = new TechnicalAnalyzers();
    private orderFlowAnalyzer = new OrderFlowAnalyzer();
    private scoringEngine = new ScoringEngine();
    private tacticalEntryAnalyzer = new TacticalEntryAnalyzer();
    private readonly strategyVersion = 'analysis-mvp-v1';

    constructor(
        private dbService: DatabaseService,
        redisService: RedisService,
        marketDataService: MarketDataService
    ) {
        this.candleService = new CandleService(redisService);
        this.dominanceService = new DominanceService(redisService, dbService);
        this.derivativesService = new DerivativesService(marketDataService);
    }

    public getSupportedSymbols(): string[] {
        return ANALYSIS_TOP_SYMBOLS;
    }

    public async getClosedCandles(symbolInput: string, timeframe: Timeframe = '4h', limit: number = 240): Promise<Candle[]> {
        const symbol = this.normalizeSymbol(symbolInput);
        const candles = await this.candleService.getCandles(symbol, timeframe, limit);
        return this.stripOpenCandles({ [timeframe]: candles } as Record<Timeframe, Candle[]>)[timeframe];
    }

    public async analyze(symbolInput: string, locale: 'ru' | 'en' = 'en', options: { persistSignal?: boolean; includeAiSummary?: boolean; updateSignalTracking?: boolean } = {}): Promise<AnalysisResult> {
        const persistSignal = options.persistSignal !== false;
        const includeAiSummary = options.includeAiSummary !== false;
        const updateSignalTracking = options.updateSignalTracking !== false;
        const symbol = this.normalizeSymbol(symbolInput);
        if (!ANALYSIS_TOP_SYMBOLS.includes(symbol)) {
            throw new Error(`Unsupported symbol for MVP. Supported top-20: ${ANALYSIS_TOP_SYMBOLS.join(', ')}`);
        }

        const [rawAssetCandles, rawBtcCandles, marketContext, liveCurrentPrice] = await Promise.all([
            this.candleService.getMultiTimeframeCandles(symbol),
            this.candleService.getMultiTimeframeCandles('BTCUSDT'),
            this.dominanceService.getMarketContext(),
            this.candleService.getCurrentPrice(symbol).catch(error => {
                console.warn(`⚠️ Live ticker price unavailable for ${symbol}; falling back to last closed 4H close.`, error.message || error);
                return undefined;
            })
        ]);

        const assetCandles = this.stripOpenCandles(rawAssetCandles);
        const btcCandles = this.stripOpenCandles(rawBtcCandles);
        const currentPrice = liveCurrentPrice || assetCandles['4h'][assetCandles['4h'].length - 1].close;

        const weeklyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1w']);
        const dailyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1d']);
        const h4Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['4h']);
        const h1Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['1h']);
        const h4Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['4h']);
        const h4Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['4h'], '4h', currentPrice);
        const h4Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['4h']);
        const h1Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['1h']);
        const h1Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['1h'], '1h', currentPrice);
        const h1Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['1h']);
        const btcDailyTrend = this.technicalAnalyzers.analyzeTrend(btcCandles['1d']);
        const btcH4Trend = this.technicalAnalyzers.analyzeTrend(btcCandles['4h']);
        const derivatives = await this.derivativesService.analyze(symbol, assetCandles['4h']);
        const orderFlow = this.orderFlowAnalyzer.analyze(assetCandles['4h']);
        const h1OrderFlow = this.orderFlowAnalyzer.analyze(assetCandles['1h']);

        const preliminaryBias = h4Structure.structure === 'BEARISH_STRUCTURE' ? -1 : 1;
        const volume = this.technicalAnalyzers.analyzeVolume(assetCandles['4h'], preliminaryBias);
        const h1Volume = this.technicalAnalyzers.analyzeVolume(assetCandles['1h'], preliminaryBias);
        const triggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['4h'], volume);
        const h1TriggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['1h'], h1Volume);
        const retest = this.technicalAnalyzers.analyzeRetest(assetCandles['4h'], h4Levels);
        const marketRegimeAnalysis = this.technicalAnalyzers.analyzeMarketRegime(assetCandles['4h'], h4Structure, h4Levels, volume);

        const scored = this.scoringEngine.score({
            symbol,
            currentPrice,
            weeklyTrend,
            dailyTrend,
            h4Trend,
            h1Trend,
            h4Structure,
            h4Levels,
            h4Atr,
            volume,
            btcDailyTrend,
            btcH4Trend,
            marketContext,
            derivatives,
            orderFlow,
            triggerCandle,
            retest,
            marketRegimeAnalysis
        });
        const actionableEntryZone = await this.resolveActionableEntryZoneLifecycle(
            symbol,
            scored.actionableEntryZone,
            currentPrice,
            scored.riskManagement,
            assetCandles['4h']
        );
        const tacticalSetup = this.tacticalEntryAnalyzer.analyze({
            symbol,
            currentPrice,
            mainDecision: scored.decision,
            primaryScenario: scored.primaryScenario,
            directionScore: scored.directionScore,
            entry: scored.entry,
            riskManagement: scored.riskManagement,
            h1Trend,
            h1Structure,
            h1Levels,
            h1Atr,
            h1TriggerCandle,
            h1OrderFlow,
            usdtDominance: marketContext.usdtDominance,
            h4Invalidation: scored.riskManagement.scenarioInvalidation,
            actionableEntryZone
        });
        await this.recordTacticalSetupEvent(symbol, tacticalSetup);
        if (updateSignalTracking) {
            await this.updatePostSignalTracking(symbol, assetCandles['4h']);
        }
        const signalOutcome = this.buildInitialSignalOutcome(scored.decision);
        const deltaSign = orderFlow.deltaCurrent >= 0 ? '+' : '-';
        const deltaMillions = Math.abs(orderFlow.deltaCurrent) / 1_000_000;
        const deltaRatioText = `${Math.abs(orderFlow.deltaRatio).toFixed(2)}x avg`;
        const btcDominanceText = symbol === 'BTCUSDT'
            ? `BTC.D ${marketContext.btcDominance.trend} at ${marketContext.btcDominance.value.toFixed(2)}%, slope ${marketContext.btcDominance.slope}, position ${marketContext.btcDominance.positionInRange}. Informational only for BTCUSDT.`
            : `BTC.D ${marketContext.btcDominance.trend} at ${marketContext.btcDominance.value.toFixed(2)}%, slope ${marketContext.btcDominance.slope}, position ${marketContext.btcDominance.positionInRange}, impact ${marketContext.btcDominance.signalImpact}.`;
        const altMarketFilter = symbol === 'BTCUSDT'
            ? 'Altcoin market filter is N/A for BTCUSDT.'
            : scored.categoryScores.find(item => item.category === 'BTC_DOMINANCE')?.explanation || btcDominanceText;
        const btcContextText = symbol === 'BTCUSDT'
            ? 'BTC context is the analyzed asset; external BTC filter is N/A.'
            : `BTC daily ${btcDailyTrend.trend}, BTC 4H ${btcH4Trend.trend}.`;

        const result: AnalysisResult = {
            symbol,
            timeframe: '4h',
            decision: scored.decision,
            score: scored.score,
            confidence: scored.confidence,
            tradeConfidence: scored.tradeConfidence,
            directionScore: scored.directionScore,
            setupQualityScore: scored.setupQualityScore,
            riskScore: scored.riskScore,
            primaryScenario: scored.primaryScenario,
            riskSide: scored.riskSide,
            setupQuality: scored.setupQuality,
            setupReason: scored.setupReason,
            mainReason: scored.mainReason,
            currentAction: scored.currentAction,
            whyNotNow: scored.whyNotNow,
            aiSummary: '',
            marketRegime: scored.marketRegime,
            marketRegimeDetails: marketRegimeAnalysis,
            marketState: {
                weeklyTrend: weeklyTrend.trend,
                dailyTrend: dailyTrend.trend,
                h4Trend: h4Structure.structure,
                h1Trend: h1Trend.trend,
                btcDailyTrend: btcDailyTrend.trend,
                btcH4Trend: btcH4Trend.trend
            },
            entry: scored.entry,
            dynamicReferenceZone: scored.dynamicReferenceZone,
            actionableEntryZone,
            activationLevels: scored.activationLevels,
            riskManagement: scored.riskManagement,
            analysis: {
                htfContext: `Weekly ${weeklyTrend.trend}, daily ${dailyTrend.trend}.`,
                marketStructure: `4H ${h4Structure.structure}; BOS ${h4Structure.bos}; zone ${h4Levels.premiumDiscount}. ${h4Levels.summary}`,
                volume: `4H volume is ${volume.ratio.toFixed(2)}x average (${volume.signal}), trend ${volume.trend}.`,
                orderFlow: `Delta ${deltaSign}${deltaMillions.toFixed(1)}M quote (${deltaRatioText}), CVD ${orderFlow.cvdTrend}, divergence ${orderFlow.divergence}, impact ${orderFlow.impact}.`,
                btc: btcContextText,
                btcDominance: btcDominanceText,
                altMarketFilter,
                usdtDominance: `USDT.D ${marketContext.usdtDominance.trend} at ${marketContext.usdtDominance.value.toFixed(2)}%, slope ${marketContext.usdtDominance.slope}, position ${marketContext.usdtDominance.positionInRange}, impact ${marketContext.usdtDominance.signalImpact}.`,
                derivatives: `Funding ${(derivatives.fundingRate * 100).toFixed(4)}% (30d rank ${derivatives.fundingPercentile30d}/100, z ${derivatives.fundingZScore30d}), OI $${(derivatives.openInterestUsd / 1_000_000).toFixed(1)}M. ${derivatives.positioningInterpretation}. ${derivatives.oiInterpretation}`,
                riskReward: scored.riskManagement.riskReward ? `Estimated R/R ${scored.riskManagement.riskReward}.` : scored.riskManagement.reason || 'R/R unavailable.',
                volatility: `4H ATR ${h4Atr.atrPercent.toFixed(2)}%. ${marketRegimeAnalysis.summary}`,
                triggerCandle: triggerCandle.summary,
                retest: retest.summary,
                signalTracking: signalOutcome.status === 'NO_TRADE' ? 'No active signal to track while decision is WAIT.' : 'Signal tracking started; MFE/MAE will update on future analyses.',
                retestStatus: this.buildRetestStatus(retest.state, scored.riskManagement.retestEntryComment),
                oiWarning: this.buildOiWarning(derivatives),
                requiredEntry: scored.riskManagement.requiredEntryComment || 'Required entry cannot be calculated with current risk geometry.'
            },
            categoryScores: scored.categoryScores,
            reasoning: scored.reasoning,
            warnings: scored.warnings,
            nextConditions: scored.nextConditions,
            bias: scored.bias,
            reasonForDecision: scored.reasonForDecision,
            signalOutcome,
            tacticalSetup,
            createdAt: new Date().toISOString(),
            strategyVersion: this.strategyVersion
        };
        result.aiSummary = includeAiSummary ? await this.buildAiOrRuleBasedSummary(result, locale) : this.buildRuleBasedSummary(result, locale);

        if (persistSignal) {
            await this.dbService.saveAnalysisSignal({
                symbol: result.symbol,
                timeframe: result.timeframe,
                decision: result.decision,
                score: result.score,
                confidence: result.confidence,
                entryFrom: result.entry.from,
                entryTo: result.entry.to,
                stopLoss: result.riskManagement.stopLoss,
                takeProfits: result.riskManagement.takeProfit,
                invalidation: result.riskManagement.invalidation,
                reasoning: result.reasoning,
                warnings: result.warnings,
                rawAnalysis: result,
                signalOutcome: result.signalOutcome,
                strategyVersion: result.strategyVersion,
                createdAt: new Date(result.createdAt)
            });
        }

        return result;
    }

    public async captureSnapshot(symbolInput: string): Promise<AnalysisSnapshot> {
        const symbol = this.normalizeSymbol(symbolInput);
        if (!ANALYSIS_TOP_SYMBOLS.includes(symbol)) {
            throw new Error(`Unsupported symbol for snapshot: ${symbol}`);
        }

        const [rawAssetCandles, rawBtcCandles, marketContext, liveCurrentPrice] = await Promise.all([
            this.candleService.getMultiTimeframeCandles(symbol),
            this.candleService.getMultiTimeframeCandles('BTCUSDT'),
            this.dominanceService.getMarketContext(),
            this.candleService.getCurrentPrice(symbol).catch(error => {
                console.warn(`⚠️ Live ticker price unavailable for ${symbol}; falling back to last closed 4H close.`, error.message || error);
                return undefined;
            })
        ]);

        const assetCandles = this.stripOpenCandles(rawAssetCandles);
        const btcCandles = this.stripOpenCandles(rawBtcCandles);
        const currentPrice = liveCurrentPrice || assetCandles['4h'][assetCandles['4h'].length - 1].close;
        const weeklyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1w']);
        const dailyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1d']);
        const h4Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['4h']);
        const h1Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['1h']);
        const h4Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['4h']);
        const h4Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['4h'], '4h', currentPrice);
        const h4Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['4h']);
        const h1Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['1h']);
        const h1Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['1h'], '1h', currentPrice);
        const h1Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['1h']);
        const btcDailyTrend = this.technicalAnalyzers.analyzeTrend(btcCandles['1d']);
        const btcH4Trend = this.technicalAnalyzers.analyzeTrend(btcCandles['4h']);
        const derivatives = await this.derivativesService.analyze(symbol, assetCandles['4h']);
        const orderFlow = this.orderFlowAnalyzer.analyze(assetCandles['4h']);
        const h1OrderFlow = this.orderFlowAnalyzer.analyze(assetCandles['1h']);
        const preliminaryBias = h4Structure.structure === 'BEARISH_STRUCTURE' ? -1 : 1;
        const volume = this.technicalAnalyzers.analyzeVolume(assetCandles['4h'], preliminaryBias);
        const h1Volume = this.technicalAnalyzers.analyzeVolume(assetCandles['1h'], preliminaryBias);
        const triggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['4h'], volume);
        const h1TriggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['1h'], h1Volume);
        const retest = this.technicalAnalyzers.analyzeRetest(assetCandles['4h'], h4Levels);
        const marketRegimeAnalysis = this.technicalAnalyzers.analyzeMarketRegime(assetCandles['4h'], h4Structure, h4Levels, volume);
        const scored = this.scoringEngine.score({
            symbol,
            currentPrice,
            weeklyTrend,
            dailyTrend,
            h4Trend,
            h1Trend,
            h4Structure,
            h4Levels,
            h4Atr,
            volume,
            btcDailyTrend,
            btcH4Trend,
            marketContext,
            derivatives,
            orderFlow,
            triggerCandle,
            retest,
            marketRegimeAnalysis
        });
        const actionableEntryZone = await this.resolveActionableEntryZoneLifecycle(
            symbol,
            scored.actionableEntryZone,
            currentPrice,
            scored.riskManagement,
            assetCandles['4h']
        );
        const tacticalSetup = this.tacticalEntryAnalyzer.analyze({
            symbol,
            currentPrice,
            mainDecision: scored.decision,
            primaryScenario: scored.primaryScenario,
            directionScore: scored.directionScore,
            entry: scored.entry,
            riskManagement: scored.riskManagement,
            h1Trend,
            h1Structure,
            h1Levels,
            h1Atr,
            h1TriggerCandle,
            h1OrderFlow,
            usdtDominance: marketContext.usdtDominance,
            h4Invalidation: scored.riskManagement.scenarioInvalidation,
            actionableEntryZone
        });
        await this.recordTacticalSetupEvent(symbol, tacticalSetup);

        const snapshot: AnalysisSnapshot = {
            symbol,
            timeframe: '4h',
            price: currentPrice,
            decision: scored.decision,
            bias: scored.bias,
            directionScore: scored.directionScore,
            setupQualityScore: scored.setupQualityScore,
            riskScore: scored.riskScore,
            primaryScenario: scored.primaryScenario,
            riskSide: scored.riskSide,
            setupQuality: scored.setupQuality,
            entryStatus: scored.riskManagement.currentEntryStatus,
            actionableEntryZoneFrom: actionableEntryZone?.from,
            actionableEntryZoneTo: actionableEntryZone?.to,
            actionableEntryZoneStatus: actionableEntryZone?.status,
            actionableEntryZoneSource: actionableEntryZone?.source,
            actionableEntryZoneSetupId: actionableEntryZone?.setupId,
            actionableEntryZoneRr: actionableEntryZone?.rr,
            actionableEntryZoneTradable: actionableEntryZone?.isTradable,
            actionableEntryZoneNotTradableReason: actionableEntryZone?.notTradableReason,
            actionableEntryZoneExpirationReason: actionableEntryZone?.expirationReason,
            longActivationLevel: scored.activationLevels.long,
            shortActivationLevel: scored.activationLevels.short,
            riskReward: scored.riskManagement.riskReward,
            requiredEntryForMinRr: scored.riskManagement.requiredEntryForMinRr,
            marketRegime: scored.marketRegime,
            weeklyTrend: weeklyTrend.trend,
            dailyTrend: dailyTrend.trend,
            h4Structure: h4Structure.structure,
            h1Trend: h1Trend.trend,
            nearestSupport: h4Levels.nearestSupport?.price,
            nearestResistance: h4Levels.nearestResistance?.price,
            premiumDiscount: h4Levels.premiumDiscount,
            volumeRatio: volume.ratio,
            volumeTrend: volume.trend,
            triggerQuality: triggerCandle.quality,
            retestState: retest.state,
            fundingRate: derivatives.fundingRate,
            fundingPercentile30d: derivatives.fundingPercentile30d,
            fundingZScore30d: derivatives.fundingZScore30d,
            openInterestUsd: derivatives.openInterestUsd,
            oiChange4h: derivatives.oiChange4h,
            oiChange24h: derivatives.oiChange24h,
            oiChange7d: derivatives.oiChange7d,
            priceOiDivergence: derivatives.priceOiDivergence,
            longShortRatio: derivatives.longShortRatio,
            cvdTrend: orderFlow.cvdTrend,
            deltaRatio: orderFlow.deltaRatio,
            cvdDivergence: orderFlow.divergence,
            btcDominanceValue: marketContext.btcDominance.value,
            btcDominanceTrend: marketContext.btcDominance.trend,
            btcDominanceSlope: marketContext.btcDominance.slope,
            btcDominanceChange4h: marketContext.btcDominance.change4h,
            btcDominancePosition: marketContext.btcDominance.positionInRange,
            btcDominanceBreakoutStatus: marketContext.btcDominance.breakoutStatus,
            btcDominanceScore: scored.categoryScores.find(item => item.category === 'BTC_DOMINANCE')?.score || 0,
            btcDominanceImpact: marketContext.btcDominance.signalImpact,
            usdtDominanceValue: marketContext.usdtDominance.value,
            usdtDominanceTrend: marketContext.usdtDominance.trend,
            usdtDominanceSlope: marketContext.usdtDominance.slope,
            usdtDominanceChange4h: marketContext.usdtDominance.change4h,
            usdtDominancePosition: marketContext.usdtDominance.positionInRange,
            usdtDominanceBreakoutStatus: marketContext.usdtDominance.breakoutStatus,
            usdtDominanceScore: marketContext.usdtDominance.score,
            usdtDominanceImpact: marketContext.usdtDominance.signalImpact,
            tacticalStatus: tacticalSetup.status,
            tacticalSide: tacticalSetup.side,
            tacticalZoneFrom: tacticalSetup.zone?.from,
            tacticalZoneTo: tacticalSetup.zone?.to,
            tacticalRR: tacticalSetup.rr,
            tacticalStop: tacticalSetup.stop?.price,
            tacticalRequiredEntryForMinRr: tacticalSetup.requiredEntryForMinRr,
            tacticalZoneStatus: tacticalSetup.zoneStatus,
            tacticalReason: tacticalSetup.reason,
            strategyVersion: this.strategyVersion,
            createdAt: new Date()
        };

        await this.dbService.saveAnalysisSnapshot(snapshot);
        return snapshot;
    }

    private normalizeSymbol(input: string): string {
        const symbol = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
    }

    private stripOpenCandles(candlesByTimeframe: Record<Timeframe, Candle[]>): Record<Timeframe, Candle[]> {
        const now = Date.now();
        const result = {} as Record<Timeframe, Candle[]>;

        (Object.keys(candlesByTimeframe) as Timeframe[]).forEach(timeframe => {
            result[timeframe] = candlesByTimeframe[timeframe].filter(candle => candle.closeTime < now);
            if (result[timeframe].length < 60 && timeframe !== '1w') {
                throw new Error(`Not enough closed candles for ${timeframe}.`);
            }
        });

        if (result['4h'].length === 0) {
            throw new Error('No closed 4H candles returned.');
        }

        return result;
    }

    private buildInitialSignalOutcome(decision: AnalysisResult['decision']): SignalOutcome {
        return {
            status: decision === 'WAIT' ? 'NO_TRADE' : 'OPEN',
            maxFavorableExcursionPct: 0,
            maxAdverseExcursionPct: 0,
            hitTP1: false,
            hitTP2: false,
            hitSL: false,
            updatedAt: new Date().toISOString()
        };
    }

    private buildRetestStatus(state: RetestAnalysis['state'], entryComment?: string): string {
        if (entryComment) return `Retest Status: confirmed, but current entry is missed. ${entryComment}`;
        return `Retest Status: ${state.toLowerCase()}.`;
    }

    private buildOiWarning(derivatives: DerivativesAnalysis): string {
        if (derivatives.priceOiDivergence !== 'LEVERAGE_BUILDUP') {
            return `OI: ${derivatives.oiInterpretation}`;
        }

        const positioning = derivatives.longShortRatio < 0.7
            ? 'Top traders are short-biased, so upside squeeze is possible if resistance breaks.'
            : derivatives.longShortRatio > 1.5
                ? 'Top traders are long-biased, so failed breakout can create downside liquidation risk.'
                : 'Positioning is not extreme, so wait for price confirmation.';

        if (derivatives.oiChange4h < 0 && derivatives.oiChange24h > 0) {
            return `OI Warning: OI grew ${derivatives.oiChange24h.toFixed(2)}% over 24h, but fell ${Math.abs(derivatives.oiChange4h).toFixed(2)}% over 4h. Leverage buildup exists on the wider window, but short-term OI is cooling. ${positioning} Avoid entering before confirmation.`;
        }

        return `OI Warning: OI increased ${derivatives.oiChange24h.toFixed(2)}% over 24h while price is flat/weak near a key area. This indicates leverage buildup. ${positioning} Avoid entering before confirmation.`;
    }

    private async resolveActionableEntryZoneLifecycle(
        symbol: string,
        candidate: ActionableEntryZone | undefined,
        currentPrice: number,
        risk: RiskManagementPlan,
        h4Candles: Candle[]
    ): Promise<ActionableEntryZone | undefined> {
        const active = await this.dbService.getActiveActionableSetup(symbol, '4h');
        const now = new Date();

        if (active && active.expiresAt <= now) {
            await this.dbService.updateActionableSetup(active.setupId, {
                status: 'EXPIRED',
                expiredReason: 'TIME_EXPIRED',
                updatedAt: now
            });
            await this.recordActionableSetupEvent(active, 'EXPIRED', currentPrice, risk, 'TIME_EXPIRED');
            if (!candidate) {
                return undefined;
            }
        } else if (!candidate) {
            if (active) {
                await this.dbService.updateActionableSetup(active.setupId, {
                    status: 'EXPIRED',
                    expiredReason: 'SCENARIO_TURNED_NEUTRAL',
                    updatedAt: now
                });
                await this.recordActionableSetupEvent(active, 'EXPIRED', currentPrice, risk, 'SCENARIO_TURNED_NEUTRAL');
            }
            return undefined;
        } else if (active && active.setupId === candidate.setupId) {
            const status = this.calculateActionableZoneStatus(active, currentPrice, risk);
            await this.dbService.updateActionableSetup(active.setupId, {
                status,
                currentPrice,
                requiredEntryForMinRr: risk.requiredEntryForMinRr,
                riskReward: risk.riskReward,
                stopLoss: risk.stopLoss,
                target: risk.takeProfit[0],
                invalidation: risk.invalidation || risk.scenarioInvalidation,
                updatedAt: now
            });
            await this.recordActionableSetupEvent(
                active,
                status,
                currentPrice,
                risk,
                status === 'INVALIDATED' ? 'INVALIDATION_HIT' : this.getActionableNotTradableReason(status, risk.riskReward) || 'STATUS_CHANGED'
            );
            return this.toActionableEntryZone({ ...active, riskReward: risk.riskReward }, status);
        } else if (active && candidate) {
            const expiredReason = this.getReplacementReason(candidate);
            await this.dbService.updateActionableSetup(active.setupId, {
                status: 'EXPIRED',
                replacedBySetupId: candidate.setupId,
                expiredReason,
                updatedAt: now
            });
            await this.recordActionableSetupEvent(active, 'EXPIRED', currentPrice, risk, expiredReason);
        }

        if (!candidate) return undefined;

        const setup = this.buildActionableSetupRecord(symbol, candidate, currentPrice, risk, h4Candles);
        setup.status = this.calculateActionableZoneStatus(setup, currentPrice, risk);
        await this.dbService.createActionableSetup(setup);
        await this.recordActionableSetupEvent(setup, setup.status, currentPrice, risk, 'SETUP_CREATED');
        return this.toActionableEntryZone(setup, setup.status);
    }

    private async recordActionableSetupEvent(
        setup: Pick<ActionableSetupRecord, 'setupId' | 'symbol' | 'timeframe' | 'side' | 'from' | 'to' | 'source' | 'status'>,
        status: ActionableEntryZone['status'],
        currentPrice: number,
        risk: RiskManagementPlan,
        reason?: ActionableSetupEventReason
    ): Promise<void> {
        const latest = await this.dbService.getLatestActionableSetupEvent(setup.setupId);
        const nextRiskReward = this.optionalFiniteNumber(risk.riskReward);
        const nextRequiredEntry = this.optionalFiniteNumber(risk.requiredEntryForMinRr);
        const tradable = status === 'IN_ZONE' && nextRiskReward !== undefined && nextRiskReward >= 1.8;
        const latestRr = this.roundOptional(latest?.riskReward, 4);
        const nextRr = this.roundOptional(nextRiskReward, 4);
        const latestRequired = this.roundOptional(latest?.requiredEntryForMinRr, 4);
        const nextRequired = this.roundOptional(nextRequiredEntry, 4);

        if (
            latest &&
            latest.status === status &&
            latest.tradable === tradable &&
            latestRr === nextRr &&
            latestRequired === nextRequired
        ) {
            return;
        }

        await this.dbService.saveActionableSetupEvent({
            setupId: setup.setupId,
            symbol: setup.symbol,
            timeframe: setup.timeframe,
            side: setup.side,
            status,
            previousStatus: latest?.status,
            from: Math.min(setup.from, setup.to),
            to: Math.max(setup.from, setup.to),
            currentPrice,
            requiredEntryForMinRr: nextRequiredEntry,
            riskReward: nextRiskReward,
            tradable,
            reason,
            source: setup.source,
            createdAt: new Date()
        });
    }

    private async recordTacticalSetupEvent(symbol: string, tacticalSetup: TacticalSetup): Promise<void> {
        const latest = await this.dbService.getLatestTacticalSetupEvent(symbol);
        const nextZoneFrom = tacticalSetup.zone?.from;
        const nextZoneTo = tacticalSetup.zone?.to;
        const nextStop = tacticalSetup.stop?.price;
        const nextRiskReward = this.optionalFiniteNumber(tacticalSetup.rr);
        const nextRequiredEntry = this.optionalFiniteNumber(tacticalSetup.requiredEntryForMinRr);
        const latestRr = this.roundOptional(latest?.rr, 4);
        const nextRr = this.roundOptional(nextRiskReward, 4);
        const latestRequired = this.roundOptional(latest?.requiredEntryForMinRr, 4);
        const nextRequired = this.roundOptional(nextRequiredEntry, 4);

        if (
            latest &&
            latest.status === tacticalSetup.status &&
            latest.side === tacticalSetup.side &&
            latest.zoneStatus === tacticalSetup.zoneStatus &&
            latestRr === nextRr &&
            latestRequired === nextRequired &&
            latest.zoneFrom === nextZoneFrom &&
            latest.zoneTo === nextZoneTo &&
            latest.stop === nextStop
        ) {
            return;
        }

        await this.dbService.saveTacticalSetupEvent({
            symbol,
            timeframe: tacticalSetup.timeframe,
            status: tacticalSetup.status,
            previousStatus: latest?.status,
            side: tacticalSetup.side,
            zoneFrom: nextZoneFrom,
            zoneTo: nextZoneTo,
            zoneStatus: tacticalSetup.zoneStatus,
            rr: nextRiskReward,
            stop: nextStop,
            requiredEntryForMinRr: nextRequiredEntry,
            reason: tacticalSetup.reason,
            createdAt: new Date()
        });
    }

    private roundOptional(value: unknown, digits: number): number | undefined {
        const parsed = this.optionalFiniteNumber(value);
        return parsed === undefined ? undefined : Number(parsed.toFixed(digits));
    }

    private optionalFiniteNumber(value: unknown): number | undefined {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private buildActionableSetupRecord(
        symbol: string,
        zone: ActionableEntryZone,
        currentPrice: number,
        risk: RiskManagementPlan,
        h4Candles: Candle[]
    ): ActionableSetupRecord {
        const now = new Date();
        const lastClosedH4 = h4Candles[h4Candles.length - 1];
        return {
            setupId: zone.setupId,
            symbol,
            timeframe: '4h',
            side: zone.side,
            from: Math.min(zone.from, zone.to),
            to: Math.max(zone.from, zone.to),
            source: zone.source,
            status: zone.status,
            createdAtCandleTime: zone.createdAtCandleTime || new Date(lastClosedH4.closeTime).toISOString(),
            currentPrice,
            requiredEntryForMinRr: risk.requiredEntryForMinRr,
            riskReward: risk.riskReward,
            stopLoss: risk.stopLoss,
            target: risk.takeProfit[0],
            invalidation: risk.invalidation || risk.scenarioInvalidation,
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000)
        };
    }

    private calculateActionableZoneStatus(
        zone: Pick<ActionableSetupRecord, 'side' | 'from' | 'to' | 'status'>,
        currentPrice: number,
        risk: RiskManagementPlan
    ): ActionableEntryZone['status'] {
        if (zone.status === 'EXPIRED') return 'EXPIRED';

        const invalidated = zone.side === 'LONG'
            ? risk.stopLoss !== undefined && currentPrice <= risk.stopLoss
            : risk.stopLoss !== undefined && currentPrice >= risk.stopLoss;
        if (invalidated) return 'INVALIDATED';

        const invalidByRr = zone.side === 'LONG'
            ? risk.requiredEntryForMinRr !== undefined && risk.requiredEntryForMinRr < zone.from
            : risk.requiredEntryForMinRr !== undefined && risk.requiredEntryForMinRr > zone.to;
        if (invalidByRr) return 'INVALID_BY_RR';

        if (currentPrice >= zone.from && currentPrice <= zone.to) return 'IN_ZONE';

        const missed = zone.side === 'LONG'
            ? currentPrice > zone.to
            : currentPrice < zone.from;
        return missed ? 'MISSED' : 'WATCHING';
    }

    private toActionableEntryZone(
        setup: Pick<ActionableSetupRecord, 'from' | 'to' | 'side' | 'source' | 'setupId' | 'createdAtCandleTime' | 'expiresAt' | 'riskReward' | 'expiredReason'>,
        status: ActionableEntryZone['status']
    ): ActionableEntryZone {
        return {
            from: setup.from,
            to: setup.to,
            side: setup.side,
            source: setup.source,
            status,
            createdAtCandleTime: setup.createdAtCandleTime,
            expiresAt: setup.expiresAt.toISOString(),
            rr: setup.riskReward,
            isTradable: status === 'IN_ZONE' && setup.riskReward !== undefined && setup.riskReward >= 1.8,
            notTradableReason: this.getActionableNotTradableReason(status, setup.riskReward),
            expirationReason: status === 'INVALIDATED' ? 'INVALIDATION_HIT' : undefined,
            setupId: setup.setupId
        };
    }

    private getReplacementReason(candidate: ActionableEntryZone): SetupExpirationReason {
        return candidate.source === 'BREAKOUT_RETEST_LEVEL' ? 'NEW_BREAKOUT_SETUP' : 'NEW_STRUCTURE_CREATED';
    }

    private getActionableNotTradableReason(
        status: ActionableEntryZone['status'],
        rr?: number
    ): ActionableEntryZone['notTradableReason'] {
        if (status === 'INVALIDATED') return 'INVALIDATED';
        if (status === 'EXPIRED') return 'EXPIRED';
        if (status !== 'IN_ZONE') return 'NOT_IN_ZONE';
        if (rr === undefined || rr < 1.8) return 'RR_BELOW_MINIMUM';
        return undefined;
    }

    private async buildAiOrRuleBasedSummary(result: AnalysisResult, locale: 'ru' | 'en'): Promise<string> {
        const fallback = this.buildRuleBasedSummary(result, locale);
        if (!ANALYSIS_AI_SUMMARY_ENABLED || !OPENAI_API_KEY) return fallback;
        if (result.decision === 'WAIT') return fallback;
        if (result.primaryScenario === 'NEUTRAL' || Math.abs(result.directionScore) < 70) return fallback;

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: ANALYSIS_AI_MODEL,
                    temperature: 0.2,
                    max_tokens: 180,
                    messages: [
                        {
                            role: 'system',
                            content: `Write a concise ${locale === 'ru' ? 'Russian' : 'English'} crypto analysis summary from provided structured data only. Do not repeat numeric header fields. Do not invent indicators, prices, or conclusions. If primaryScenario is NEUTRAL, do not call it a current long or short setup; say there is no directional edge and both sides need confirmation. If SMA20/ATR extension is mentioned, use exactly this meaning: price deviated from the 20-period SMA on 4H by N ATR. Never write that price exceeds ATR or 20-day SMA. Use R/R, not risk/reward translation. No financial advice. Do not use Markdown formatting.`
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({
                                symbol: result.symbol,
                                decision: result.decision,
                                bias: result.bias,
                                primaryScenario: result.primaryScenario,
                                riskSide: result.riskSide,
                                directionScore: result.directionScore,
                                setupQuality: result.setupQuality,
                                setupQualityScore: result.setupQualityScore,
                                riskScore: result.riskScore,
                                mainReason: result.mainReason,
                                currentAction: result.currentAction,
                                whyNotNow: result.whyNotNow,
                                retest: result.analysis.retestStatus,
                                requiredEntry: result.analysis.requiredEntry,
                                oiWarning: result.analysis.oiWarning
                            })
                        }
                    ]
                })
            });

            if (!response.ok) return fallback;
            const data = await response.json() as any;
            return this.sanitizeAiText(data.choices?.[0]?.message?.content?.trim() || fallback);
        } catch (error) {
            console.error('AI analysis summary failed:', error);
            return fallback;
        }
    }

    private buildRuleBasedSummary(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (result.primaryScenario === 'NEUTRAL') {
            const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
            const volumeTextRu = result.analysis.volume.includes('HIGH_CONFIRMATION')
                ? 'Объём высокий, но сама структура пробоя не подтверждена.'
                : 'Объём сам по себе не даёт достаточного подтверждения.';
            const crowdedRu = this.hasCrowdedLongText(result.analysis.derivatives)
                ? 'Funding/позиционирование указывают на риск перегрева long-стороны.'
                : 'Деривативы не дают самостоятельного торгового сигнала.';
            const volumeTextEn = result.analysis.volume.includes('HIGH_CONFIRMATION')
                ? 'Volume is high, but breakout structure is not confirmed.'
                : 'Volume alone does not provide enough confirmation.';
            const crowdedEn = this.hasCrowdedLongText(result.analysis.derivatives)
                ? 'Funding/positioning point to elevated long-crowding risk.'
                : 'Derivatives do not provide a standalone trade signal.';

            if (locale === 'ru') {
                return this.formatSummarySections(
                    locale,
                    `${result.symbol} сейчас не даёт чистого направления. Старшие ТФ: 1W ${result.marketState.weeklyTrend}, 1D ${result.marketState.dailyTrend}; 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}.`,
                    `R/R формально ${rr}, но этого недостаточно без directional edge. ${volumeTextRu} CVD: ${result.analysis.orderFlow}. ${crowdedRu}`,
                    'Long требует breakout/retest с CVD up. Short требует rejection или breakdown/retest с CVD down и подтверждением risk-off.'
                );
            }

            return this.formatSummarySections(
                locale,
                `${result.symbol} has no clean directional edge. HTF context is 1W ${result.marketState.weeklyTrend}, 1D ${result.marketState.dailyTrend}; 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}.`,
                `R/R is formally ${rr}, but that is not enough without directional confirmation. ${volumeTextEn} CVD: ${result.analysis.orderFlow}. ${crowdedEn}`,
                'Long needs breakout/retest with CVD up. Short needs rejection or breakdown/retest with CVD down and risk-off confirmation.'
            );
        }

        if (Math.abs(result.directionScore) < 70) {
            const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
            const required = result.riskManagement.requiredEntryForMinRr;
            const zone = this.formatEntryZone(result, 'reference zone') || 'reference zone';
            const weakBiasRu = result.primaryScenario === 'SHORT'
                ? result.directionScore <= -50 ? 'умеренно медвежий bias' : 'слабый медвежий bias'
                : result.directionScore >= 50 ? 'умеренно бычий локальный контекст' : 'слабый бычий bias';
            const weakBiasEn = result.primaryScenario === 'SHORT'
                ? result.directionScore <= -50 ? 'moderately bearish bias' : 'weak bearish bias'
                : result.directionScore >= 50 ? 'moderately bullish local context' : 'weak bullish bias';
            const crowdedRu = this.hasCrowdedLongText(result.analysis.derivatives)
                ? 'Short-идея поддерживается перегретым funding/long-biased позиционированием'
                : 'Деривативы дают только ограниченное подтверждение';
            const crowdedEn = this.hasCrowdedLongText(result.analysis.derivatives)
                ? 'The short idea is supported by overheated funding/long-biased positioning'
                : 'Derivatives provide only limited confirmation';

            if (locale === 'ru') {
                if (result.primaryScenario === 'SHORT') {
                    const requiredText = required
                        ? `Для pullback short нужен возврат примерно к ${required} или выше с rejection и R/R >= 1.8. Для breakdown short нужен пробой поддержки, ретест снизу и новый расчёт R/R.`
                        : 'Для pullback short нужен возврат в short-зону с rejection и R/R >= 1.8. Для breakdown short нужен пробой поддержки, ретест снизу и новый расчёт R/R.';
                    return this.formatSummarySections(
                        locale,
                        `${result.symbol} имеет ${weakBiasRu}: 1W/1D ${result.marketState.weeklyTrend}/${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}.`,
                        `Активной short-сделки нет. ${crowdedRu}, CVD ${result.analysis.orderFlow.includes('CVD DOWN') ? 'DOWN' : 'не даёт чистого short-подтверждения'}, вход с текущей цены поздний: цена ниже preferred short-зоны ${zone}, структура пробоя не подтверждена.`,
                        requiredText
                    );
                }

                const resistance = result.riskManagement.nearestBlockingLevel;
                const requiredText = required && resistance
                    ? `Валидный long возможен либо после отката к ${required} или ниже с новой bullish-реакцией, либо после закрытия 4H выше ${resistance} и ретеста этого уровня как поддержки.`
                    : required
                        ? `Валидный long возможен только после отката к ${required} или ниже и нового подтверждения реакции.`
                        : 'Валидный long возможен только после отката с R/R >= 1.8 или после пробоя/ретеста с новым расчётом R/R.';
                const crowdingText = this.hasCrowdedLongText(result.analysis.derivatives)
                    ? 'funding/positioning выглядят crowded,'
                    : 'деривативы не дают сильного дополнительного подтверждения,';
                const resistanceText = resistance ? `, а ближайшее сопротивление ${resistance} ограничивает TP-path` : '';
                const triggerCandle = result.analysis.triggerCandle.toLowerCase();
                const triggerText = triggerCandle.includes('strong trigger')
                    ? 'trigger candle сильная'
                    : triggerCandle.includes('weak trigger')
                        ? 'trigger candle слабая и не подтверждает breakout'
                        : 'trigger candle приемлемая, но не подтверждает breakout';
                const breakoutText = resistance ? ', а breakout ещё не активирован' : '';
                const orderFlowWeak = result.analysis.orderFlow.includes('CVD FLAT') || result.analysis.orderFlow.includes('Delta -')
                    ? ' CVD flat / delta отрицательная, поэтому order-flow пока не подтверждает breakout.'
                    : '';
                if (result.directionScore >= 50) {
                    return this.formatSummarySections(
                        locale,
                        `${result.symbol} имеет ${weakBiasRu}: 1D ${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, BTC ${result.marketState.btcDailyTrend}/${result.marketState.btcH4Trend}. Но 1W ${result.marketState.weeklyTrend}, 1H ${result.marketState.h1Trend}.`,
                        `Сделки сейчас нет. Long с текущей цены считается chase: цена выше потенциальной long-зоны, R/R только ${rr} при минимуме 1.8${resistanceText}.${orderFlowWeak} Объём не подтверждает breakout.`,
                        requiredText
                    );
                }
                return this.formatSummarySections(
                    locale,
                    `${result.symbol} перешёл в локальный bullish-контекст на 4H/1H: структура 4H бычья, CVD растёт, delta положительная, ${triggerText}.`,
                    `Сделки сейчас нет. Это локальный импульс против старшего контекста: 1W/1D ${result.marketState.weeklyTrend}/${result.marketState.dailyTrend}, ${crowdingText} цена выше зоны нормального long-входа. R/R только ${rr} при минимуме 1.8${resistanceText}${breakoutText}.`,
                    requiredText
                );
            }

            if (result.primaryScenario === 'SHORT') {
                const requiredText = required
                    ? `For pullback short, price needs to return near ${required} or higher with rejection and R/R >= 1.8. For breakdown short, support must break, retest from below, and R/R must be recalculated.`
                    : 'For pullback short, price needs to return into the short zone with rejection and R/R >= 1.8. For breakdown short, support must break, retest from below, and R/R must be recalculated.';
                return this.formatSummarySections(
                    locale,
                    `${result.symbol} has a ${weakBiasEn}: 1W/1D ${result.marketState.weeklyTrend}/${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}.`,
                    `There is no active short trade now. ${crowdedEn}, but entry from current price is late: price is below the preferred short zone ${zone}, and breakdown structure is not confirmed.`,
                    requiredText
                );
            }

            const requiredText = required
                ? `For pullback long, price needs to return near ${required} or lower with bullish reaction and R/R >= 1.8. For breakout long, resistance must break, retest as support, and R/R must be recalculated.`
                : 'For pullback long, price needs to return into the long zone with bullish reaction and R/R >= 1.8. For breakout long, resistance must break, retest as support, and R/R must be recalculated.';
            return this.formatSummarySections(
                locale,
                `${result.symbol} has a ${weakBiasEn}; directional edge is positive but not clean enough for an automatic trade.`,
                'There is no active long trade now. Current entry needs new structure confirmation and acceptable R/R.',
                requiredText
            );
        }

        if (result.riskManagement.missedRetestEntry && result.primaryScenario === 'LONG') {
            const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
            const required = result.riskManagement.requiredEntryForMinRr;
            const resistance = result.riskManagement.nearestBlockingLevel;
            const zone = this.formatEntryZone(result, 'entry zone');
            const retestLevel = result.riskManagement.retestLevel;
            const squeezeRu = this.hasCrowdedShortText(result.analysis.derivatives)
                ? ` Funding находится в нижнем 30d rank, top traders short-biased, поэтому если BTC закрепится выше ${resistance || 'сопротивления'}, риск short squeeze вверх повышается.`
                : '';
            const squeezeEn = this.hasCrowdedShortText(result.analysis.derivatives)
                ? ` Funding is in a low 30d rank and top traders are short-biased, so if BTC holds above ${resistance || 'resistance'}, upside short-squeeze risk increases.`
                : '';
            const reactionRu = this.retestLevelInsideEntryZone(result)
                ? `ретест reference-зоны был подтверждён около ${retestLevel || 'уровня'}, reference-зона ${zone}, цена ушла выше неё`
                : `локальная реакция была около ${retestLevel || 'уровня'}, после чего цена ушла выше reference-зоны ${zone}`;
            const reactionEn = this.retestLevelInsideEntryZone(result)
                ? `the reference-zone retest was confirmed near ${retestLevel || 'the level'}, reference zone was ${zone}, and price moved above it`
                : `local reaction happened near ${retestLevel || 'the level'}, then price moved above the reference zone ${zone}`;

            if (locale === 'ru') {
                const requiredText = required && resistance
                    ? `Валидный long возможен либо после отката к ${required} или ниже с новой bullish-реакцией, либо после закрытия 4H выше ${resistance} и ретеста этого уровня как поддержки.`
                    : 'Валидный long возможен только после нового отката с R/R >= 1.8 или после breakout + retest.';
                const weeklyWarning = result.marketState.weeklyTrend === 'DOWNTREND'
                    ? ' При этом 1W остаётся в DOWNTREND, поэтому long требует более качественного входа и подтверждения.'
                    : '';
                const volumeRatio = this.extractVolumeRatio(result);
                const volumeText = volumeRatio ? `, объём ${volumeRatio.toFixed(2)}x не подтверждает breakout` : ', объём не подтверждает breakout';
                const orderFlowQualifier = this.getOrderFlowQualifier(result, locale);
                return this.formatSummarySections(
                    locale,
                    `${result.symbol} локально bullish: 1D ${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}, CVD ${result.analysis.orderFlow.includes('CVD UP') ? 'UP' : 'не против сценария'}${orderFlowQualifier}.${weeklyWarning}`,
                    `Сделки сейчас нет. Текущий long уже пропущен: ${reactionRu}. Покупка с текущей цены считается chase: R/R ${rr}, цена в premium, сопротивление ${resistance || 'рядом'} ограничивает TP-path${volumeText}.${squeezeRu}`,
                    requiredText
                );
            }

            const requiredText = required && resistance
                ? `Valid long needs either a pullback to ${required} or lower with a new bullish reaction, or a 4H close above ${resistance} followed by support retest.`
                : 'Valid long needs either a new pullback with R/R >= 1.8, or breakout + retest.';
            const weeklyWarning = result.marketState.weeklyTrend === 'DOWNTREND'
                ? ' Weekly remains in DOWNTREND, so long requires better entry quality and confirmation.'
                : '';
            const volumeRatio = this.extractVolumeRatio(result);
            const volumeText = volumeRatio ? `, volume ${volumeRatio.toFixed(2)}x does not confirm breakout` : ', volume does not confirm breakout';
            const orderFlowQualifier = this.getOrderFlowQualifier(result, locale);
            return this.formatSummarySections(
                locale,
                `${result.symbol} is locally bullish: 1D ${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}, CVD ${result.analysis.orderFlow.includes('CVD UP') ? 'UP' : 'not conflicting'}${orderFlowQualifier}.${weeklyWarning}`,
                `No trade now. Current long entry is missed: ${reactionEn}. Buying here is chase: R/R ${rr}, price is in premium, resistance ${resistance || 'nearby'} limits TP path${volumeText}.${squeezeEn}`,
                requiredText
            );
        }

        const sideEn = result.bias === 'BULLISH' ? 'long' : result.bias === 'BEARISH' ? 'short' : 'trade';
        const sideRu = result.bias === 'BULLISH' ? 'long' : result.bias === 'BEARISH' ? 'short' : 'сценарий';
        const resistance = result.riskManagement.nearestBlockingLevel;
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        const required = result.riskManagement.requiredEntryForMinRr;
        const retestLevel = result.riskManagement.retestLevel;
        const zone = this.formatEntryZone(result, undefined);
        const retestTextRu = result.riskManagement.missedRetestEntry
            ? 'Локальная реакция уже была, но текущий вход считается пропущенным.'
            : 'Подтверждения входа по ретесту сейчас недостаточно.';
        const retestTextEn = result.riskManagement.missedRetestEntry
            ? 'The retest was confirmed, but price moved away from the entry zone, so the current entry is considered missed.'
            : 'Retest confirmation is not enough for an active entry right now.';

        if (locale === 'ru') {
            const direction = result.bias === 'BULLISH' ? 'bullish' : result.bias === 'BEARISH' ? 'bearish' : 'нейтральным';
            const resistanceText = resistance ? ` рядом с уровнем ${resistance}` : '';
            const retestZoneText = zone
                ? this.retestLevelInsideEntryZone(result)
                    ? `Ретест reference-зоны был подтверждён${retestLevel ? ` около ${retestLevel}` : ''}; reference-зона ${zone}, цена ушла ${result.riskSide === 'LONG' ? 'выше' : 'ниже'} неё.`
                    : `Локальная реакция была${retestLevel ? ` около ${retestLevel}` : ''}, после чего цена ушла ${result.riskSide === 'LONG' ? 'выше' : 'ниже'} reference-зоны ${zone}.`
                : retestTextRu;
            const requiredText = required
                ? result.riskSide === 'LONG'
                    ? ` Сейчас сделки нет. Long допустим только после отката в зону, где R/R станет >= 1.8 (ориентир около ${required} или ниже), либо после пробоя ключевого уровня, последующего ретеста как поддержки и сохранения подтверждения по объёму/CVD.`
                    : ` Сейчас сделки нет. Pullback short допустим только после возврата к ${required} или выше с rejection и R/R >= 1.8. Breakdown short требует пробоя поддержки, ретеста снизу и нового расчёта R/R.`
                : ' Сейчас сделки нет. Ждать либо откат с R/R >= 1.8, либо пробой с объёмом, CVD и последующим ретестом.';
            const weeklyContext = result.marketState.weeklyTrend === 'RANGE' ? ', при этом 1W остаётся в диапазоне' : '';
            const structureText = result.bias === 'BULLISH' ? 'структура направлена вверх' : result.bias === 'BEARISH' ? 'структура направлена вниз' : 'структура без сильного преимущества';
            const cvdText = result.bias === 'BULLISH' ? 'CVD подтверждает покупки' : result.bias === 'BEARISH' ? 'CVD подтверждает продажи' : 'CVD не даёт сильного перекоса';
            return this.formatSummarySections(
                locale,
                `${result.symbol} сохраняет ${direction} технический контекст на 1D/4H${weeklyContext}: ${structureText}, ${cvdText}.`,
                `Текущий ${sideRu} считается пропущенным. ${retestZoneText} Цена находится в premium-зоне${resistanceText}, R/R ${rr} при минимально требуемом 1.8.`,
                requiredText.trim()
            );
        }

        const direction = result.bias === 'BULLISH' ? 'bullish' : result.bias === 'BEARISH' ? 'bearish' : 'neutral';
        const resistanceText = resistance ? ` near ${resistance}` : '';
        const requiredText = required
            ? result.riskSide === 'LONG'
                ? ` Wait for a pullback where R/R becomes >= 1.8 (around ${required} or lower), or for a breakout with volume, rising CVD, and a later retest.`
                : ` Wait for pullback short near ${required} or higher with rejection and R/R >= 1.8, or for breakdown/retest with a new R/R calculation.`
            : ' Wait for a pullback with R/R >= 1.8, or for a breakout with volume, CVD confirmation, and a later retest.';
        return this.formatSummarySections(
            locale,
            `${result.symbol} remains technically ${direction}.`,
            `Current ${sideEn} entry is late. ${retestTextEn} Price is in a poor entry area${resistanceText}, and R/R is only ${rr} versus required 1.8.`,
            requiredText.trim()
        );
    }

    private formatSummarySections(locale: 'ru' | 'en', direction: string, whyNoTrade: string, validatesTrade: string): string {
        if (locale === 'ru') {
            return `Направление: ${direction}\n\nПочему нет сделки: ${whyNoTrade}\n\nЧто валидирует сделку: ${validatesTrade}`;
        }

        return `Direction: ${direction}\n\nWhy no trade: ${whyNoTrade}\n\nWhat validates trade: ${validatesTrade}`;
    }

    private hasCrowdedLongText(text: string): boolean {
        return text.includes('long-biased') ||
            text.includes('overlong') ||
            /30d rank (9\d|100)\/100/.test(text);
    }

    private hasCrowdedShortText(text: string): boolean {
        return text.includes('short-biased') ||
            text.includes('overshort') ||
            /30d rank ([0-5])\/100/.test(text);
    }

    private formatEntryZone(result: AnalysisResult, fallback: string | undefined): string | undefined {
        if (result.entry.from === undefined || result.entry.to === undefined) return fallback;
        const from = Math.min(result.entry.from, result.entry.to);
        const to = Math.max(result.entry.from, result.entry.to);
        return `${from}-${to}`;
    }

    private retestLevelInsideEntryZone(result: AnalysisResult): boolean {
        const level = result.riskManagement.retestLevel;
        if (level === undefined || result.entry.from === undefined || result.entry.to === undefined) return false;
        const from = Math.min(result.entry.from, result.entry.to);
        const to = Math.max(result.entry.from, result.entry.to);
        return level >= from && level <= to;
    }

    private extractVolumeRatio(result: AnalysisResult): number | undefined {
        const match = result.analysis.volume.match(/([0-9.]+)x average/);
        return match ? Number(match[1]) : undefined;
    }

    private getOrderFlowQualifier(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const match = result.analysis.orderFlow.match(/\(([0-9.]+)x avg\)/i);
        const ratio = match ? Number(match[1]) : undefined;
        if (ratio === undefined || Number.isNaN(ratio) || ratio >= 1) return '';
        return locale === 'ru'
            ? `, но delta ниже среднего (${ratio.toFixed(2)}x avg)`
            : `, but delta is below average (${ratio.toFixed(2)}x avg)`;
    }

    private sanitizeAiText(text: string): string {
        return text
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/#{1,6}\s?/g, '')
            .replace(/`/g, '')
            .replace(/^\s*[-•]\s+/gm, '')
            .trim();
    }

    private async updatePostSignalTracking(symbol: string, h4Candles: Candle[]): Promise<void> {
        const signals = await this.dbService.getTrackableAnalysisSignals(symbol, '4h', 20);
        await Promise.all(signals.map(async signal => {
            const outcome = this.calculateSignalOutcome(signal.rawAnalysis as AnalysisResult, h4Candles);
            await this.dbService.updateAnalysisSignalOutcome(signal._id, outcome);
        }));
    }

    private calculateSignalOutcome(signal: AnalysisResult, h4Candles: Candle[]): SignalOutcome {
        const createdAt = new Date(signal.createdAt).getTime();
        const candles = h4Candles.filter(candle => candle.closeTime >= createdAt);
        if (signal.decision === 'WAIT' || candles.length === 0) {
            return this.buildInitialSignalOutcome('WAIT');
        }

        const entry = signal.entry.from && signal.entry.to
            ? (signal.entry.from + signal.entry.to) / 2
            : signal.entry.currentPrice;
        const stopLoss = signal.riskManagement.stopLoss;
        const [tp1, tp2, tp3] = signal.riskManagement.takeProfit;
        const isLong = signal.decision === 'LONG';

        let maxFavorable = 0;
        let maxAdverse = 0;
        let status: SignalOutcome['status'] = 'OPEN';
        let hitTP1 = false;
        let hitTP2 = false;
        let hitSL = false;
        let timeToTP1Hours: number | undefined;
        let timeToSLHours: number | undefined;

        candles.forEach(candle => {
            const favorable = isLong ? ((candle.high - entry) / entry) * 100 : ((entry - candle.low) / entry) * 100;
            const adverse = isLong ? ((candle.low - entry) / entry) * 100 : ((entry - candle.high) / entry) * 100;
            maxFavorable = Math.max(maxFavorable, favorable);
            maxAdverse = Math.min(maxAdverse, adverse);

            if (!hitTP1 && tp1 && ((isLong && candle.high >= tp1) || (!isLong && candle.low <= tp1))) {
                hitTP1 = true;
                status = 'TP1';
                timeToTP1Hours = (candle.closeTime - createdAt) / 3_600_000;
            }
            if (!hitTP2 && tp2 && ((isLong && candle.high >= tp2) || (!isLong && candle.low <= tp2))) {
                hitTP2 = true;
                status = 'TP2';
            }
            if (tp3 && ((isLong && candle.high >= tp3) || (!isLong && candle.low <= tp3))) {
                status = 'TP3';
            }
            if (!hitSL && stopLoss && ((isLong && candle.low <= stopLoss) || (!isLong && candle.high >= stopLoss))) {
                hitSL = true;
                if (!hitTP1) status = 'SL';
                timeToSLHours = (candle.closeTime - createdAt) / 3_600_000;
            }
        });

        const ageHours = (Date.now() - createdAt) / 3_600_000;
        if (status === 'OPEN' && ageHours > 7 * 24) status = 'EXPIRED';

        return {
            status,
            maxFavorableExcursionPct: Number(maxFavorable.toFixed(2)),
            maxAdverseExcursionPct: Number(maxAdverse.toFixed(2)),
            hitTP1,
            hitTP2,
            hitSL,
            timeToTP1Hours: timeToTP1Hours !== undefined ? Number(timeToTP1Hours.toFixed(1)) : undefined,
            timeToSLHours: timeToSLHours !== undefined ? Number(timeToSLHours.toFixed(1)) : undefined,
            updatedAt: new Date().toISOString()
        };
    }
}
