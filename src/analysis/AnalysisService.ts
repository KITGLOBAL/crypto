import { ANALYSIS_AI_MODEL, ANALYSIS_AI_SUMMARY_ENABLED, ANALYSIS_TOP_SYMBOLS, OPENAI_API_KEY } from '../config';
import { AnalysisResult, AnalysisSnapshot, Candle, DerivativesAnalysis, RetestAnalysis, SignalOutcome, Timeframe } from './types';
import { CandleService } from './data/CandleService';
import { DominanceService } from './data/DominanceService';
import { DerivativesService } from './data/DerivativesService';
import { TechnicalAnalyzers } from './analyzers/TechnicalAnalyzers';
import { OrderFlowAnalyzer } from './analyzers/OrderFlowAnalyzer';
import { ScoringEngine } from './analyzers/ScoringEngine';
import { DatabaseService } from '../services/DatabaseService';
import { RedisService } from '../services/RedisService';
import { MarketDataService } from '../services/MarketDataService';

export class AnalysisService {
    private candleService: CandleService;
    private dominanceService: DominanceService;
    private derivativesService: DerivativesService;
    private technicalAnalyzers = new TechnicalAnalyzers();
    private orderFlowAnalyzer = new OrderFlowAnalyzer();
    private scoringEngine = new ScoringEngine();
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

    public async analyze(symbolInput: string, locale: 'ru' | 'en' = 'en', options: { persistSignal?: boolean; includeAiSummary?: boolean; updateSignalTracking?: boolean } = {}): Promise<AnalysisResult> {
        const persistSignal = options.persistSignal !== false;
        const includeAiSummary = options.includeAiSummary !== false;
        const updateSignalTracking = options.updateSignalTracking !== false;
        const symbol = this.normalizeSymbol(symbolInput);
        if (!ANALYSIS_TOP_SYMBOLS.includes(symbol)) {
            throw new Error(`Unsupported symbol for MVP. Supported top-20: ${ANALYSIS_TOP_SYMBOLS.join(', ')}`);
        }

        const [rawAssetCandles, rawBtcCandles, marketContext] = await Promise.all([
            this.candleService.getMultiTimeframeCandles(symbol),
            this.candleService.getMultiTimeframeCandles('BTCUSDT'),
            this.dominanceService.getMarketContext()
        ]);

        const assetCandles = this.stripOpenCandles(rawAssetCandles);
        const btcCandles = this.stripOpenCandles(rawBtcCandles);

        const weeklyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1w']);
        const dailyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1d']);
        const h4Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['4h']);
        const h1Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['1h']);
        const h4Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['4h']);
        const h4Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['4h'], '4h');
        const h4Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['4h']);
        const btcDailyTrend = this.technicalAnalyzers.analyzeTrend(btcCandles['1d']);
        const btcH4Trend = this.technicalAnalyzers.analyzeTrend(btcCandles['4h']);
        const derivatives = await this.derivativesService.analyze(symbol, assetCandles['4h']);
        const orderFlow = this.orderFlowAnalyzer.analyze(assetCandles['4h']);

        const preliminaryBias = h4Structure.structure === 'BEARISH_STRUCTURE' ? -1 : 1;
        const volume = this.technicalAnalyzers.analyzeVolume(assetCandles['4h'], preliminaryBias);
        const triggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['4h'], volume);
        const retest = this.technicalAnalyzers.analyzeRetest(assetCandles['4h'], h4Levels);
        const marketRegimeAnalysis = this.technicalAnalyzers.analyzeMarketRegime(assetCandles['4h'], h4Structure, h4Levels, volume);
        const currentPrice = assetCandles['4h'][assetCandles['4h'].length - 1].close;

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
            riskManagement: scored.riskManagement,
            analysis: {
                htfContext: `Weekly ${weeklyTrend.trend}, daily ${dailyTrend.trend}.`,
                marketStructure: `4H ${h4Structure.structure}; BOS ${h4Structure.bos}; zone ${h4Levels.premiumDiscount}. ${h4Levels.summary}`,
                volume: `4H volume is ${volume.ratio.toFixed(2)}x average (${volume.signal}), trend ${volume.trend}.`,
                orderFlow: `Delta ${deltaSign}${deltaMillions.toFixed(1)}M quote (${deltaRatioText}), CVD ${orderFlow.cvdTrend}, divergence ${orderFlow.divergence}, impact ${orderFlow.impact}.`,
                btc: btcContextText,
                btcDominance: btcDominanceText,
                usdtDominance: `USDT.D ${marketContext.usdtDominance.trend} at ${marketContext.usdtDominance.value.toFixed(2)}%, slope ${marketContext.usdtDominance.slope}, position ${marketContext.usdtDominance.positionInRange}, impact ${marketContext.usdtDominance.signalImpact}.`,
                derivatives: `Funding ${(derivatives.fundingRate * 100).toFixed(4)}% (p${derivatives.fundingPercentile30d}, z ${derivatives.fundingZScore30d}), OI $${(derivatives.openInterestUsd / 1_000_000).toFixed(1)}M. ${derivatives.positioningInterpretation}. ${derivatives.oiInterpretation}`,
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

        const [rawAssetCandles, rawBtcCandles, marketContext] = await Promise.all([
            this.candleService.getMultiTimeframeCandles(symbol),
            this.candleService.getMultiTimeframeCandles('BTCUSDT'),
            this.dominanceService.getMarketContext()
        ]);

        const assetCandles = this.stripOpenCandles(rawAssetCandles);
        const btcCandles = this.stripOpenCandles(rawBtcCandles);
        const weeklyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1w']);
        const dailyTrend = this.technicalAnalyzers.analyzeTrend(assetCandles['1d']);
        const h4Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['4h']);
        const h1Trend = this.technicalAnalyzers.analyzeTrend(assetCandles['1h']);
        const h4Structure = this.technicalAnalyzers.analyzeMarketStructure(assetCandles['4h']);
        const h4Levels = this.technicalAnalyzers.analyzeLevels(assetCandles['4h'], '4h');
        const h4Atr = this.technicalAnalyzers.analyzeAtr(assetCandles['4h']);
        const btcDailyTrend = this.technicalAnalyzers.analyzeTrend(btcCandles['1d']);
        const btcH4Trend = this.technicalAnalyzers.analyzeTrend(btcCandles['4h']);
        const derivatives = await this.derivativesService.analyze(symbol, assetCandles['4h']);
        const orderFlow = this.orderFlowAnalyzer.analyze(assetCandles['4h']);
        const preliminaryBias = h4Structure.structure === 'BEARISH_STRUCTURE' ? -1 : 1;
        const volume = this.technicalAnalyzers.analyzeVolume(assetCandles['4h'], preliminaryBias);
        const triggerCandle = this.technicalAnalyzers.analyzeTriggerCandle(assetCandles['4h'], volume);
        const retest = this.technicalAnalyzers.analyzeRetest(assetCandles['4h'], h4Levels);
        const marketRegimeAnalysis = this.technicalAnalyzers.analyzeMarketRegime(assetCandles['4h'], h4Structure, h4Levels, volume);
        const currentPrice = assetCandles['4h'][assetCandles['4h'].length - 1].close;
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

        const snapshot: AnalysisSnapshot = {
            symbol,
            timeframe: '4h',
            price: currentPrice,
            decision: scored.decision,
            bias: scored.bias,
            directionScore: scored.directionScore,
            setupQualityScore: scored.setupQualityScore,
            riskScore: scored.riskScore,
            setupQuality: scored.setupQuality,
            entryStatus: scored.riskManagement.currentEntryStatus,
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
            usdtDominanceValue: marketContext.usdtDominance.value,
            usdtDominanceTrend: marketContext.usdtDominance.trend,
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

        return `OI Warning: OI increased ${derivatives.oiChange24h.toFixed(2)}% over 24h while price is flat/weak near a key area. This indicates leverage buildup. ${positioning} Avoid entering before confirmation.`;
    }

    private async buildAiOrRuleBasedSummary(result: AnalysisResult, locale: 'ru' | 'en'): Promise<string> {
        const fallback = this.buildRuleBasedSummary(result, locale);
        if (!ANALYSIS_AI_SUMMARY_ENABLED || !OPENAI_API_KEY) return fallback;

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
                            content: `Write a concise ${locale === 'ru' ? 'Russian' : 'English'} crypto analysis summary from provided structured data only. Do not repeat numeric header fields. Do not invent indicators, prices, or conclusions. If SMA20/ATR extension is mentioned, describe it as 20-period SMA on the 4H timeframe, never as 20-day SMA. No financial advice. Do not use Markdown formatting.`
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({
                                symbol: result.symbol,
                                decision: result.decision,
                                bias: result.bias,
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
        const sideEn = result.bias === 'BULLISH' ? 'long' : result.bias === 'BEARISH' ? 'short' : 'trade';
        const sideRu = result.bias === 'BULLISH' ? 'long' : result.bias === 'BEARISH' ? 'short' : 'сценарий';
        const resistance = result.riskManagement.nearestBlockingLevel;
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        const required = result.riskManagement.requiredEntryForMinRr;
        const retestLevel = result.riskManagement.retestLevel;
        const entryFrom = result.entry.from;
        const entryTo = result.entry.to;
        const retestTextRu = result.riskManagement.missedRetestEntry
            ? 'Ретест был подтверждён, но цена ушла выше зоны входа, поэтому текущий вход считается пропущенным.'
            : 'Подтверждения входа по ретесту сейчас недостаточно.';
        const retestTextEn = result.riskManagement.missedRetestEntry
            ? 'The retest was confirmed, but price moved away from the entry zone, so the current entry is considered missed.'
            : 'Retest confirmation is not enough for an active entry right now.';

        if (locale === 'ru') {
            const direction = result.bias === 'BULLISH' ? 'bullish' : result.bias === 'BEARISH' ? 'bearish' : 'нейтральным';
            const resistanceText = resistance ? ` рядом с уровнем ${resistance}` : '';
            const retestZoneText = entryFrom && entryTo
                ? `Ретест зоны ${entryFrom}-${entryTo} был подтверждён${retestLevel ? ` около ${retestLevel}` : ''}, но цена ушла выше этой зоны.`
                : retestTextRu;
            const requiredText = required
                ? ` Сейчас сделки нет. Long допустим только после отката в зону, где R/R станет >= 1.8 (ориентир около ${required}), либо после пробоя ключевого уровня, последующего ретеста как поддержки и сохранения подтверждения по объёму/CVD.`
                : ' Сейчас сделки нет. Ждать либо откат с R/R >= 1.8, либо пробой с объёмом, CVD и последующим ретестом.';
            const weeklyContext = result.marketState.weeklyTrend === 'RANGE' ? ', при этом 1W остаётся в диапазоне' : '';
            const structureText = result.bias === 'BULLISH' ? 'структура направлена вверх' : result.bias === 'BEARISH' ? 'структура направлена вниз' : 'структура без сильного преимущества';
            const cvdText = result.bias === 'BULLISH' ? 'CVD подтверждает покупки' : result.bias === 'BEARISH' ? 'CVD подтверждает продажи' : 'CVD не даёт сильного перекоса';
            return `${result.symbol} сохраняет ${direction} технический контекст на 1D/4H${weeklyContext}: ${structureText}, ${cvdText}. Но текущий ${sideRu} считается пропущенным. ${retestZoneText} Цена находится в premium-зоне${resistanceText}, а R/R составляет только ${rr} при минимально требуемом 1.8.${requiredText}`;
        }

        const direction = result.bias === 'BULLISH' ? 'bullish' : result.bias === 'BEARISH' ? 'bearish' : 'neutral';
        const resistanceText = resistance ? ` near ${resistance}` : '';
        const requiredText = required
            ? ` Wait for a pullback where R/R becomes >= 1.8 (around ${required}), or for a breakout with volume, rising CVD, and a later retest.`
            : ' Wait for a pullback with R/R >= 1.8, or for a breakout with volume, CVD confirmation, and a later retest.';
        return `${result.symbol} remains technically ${direction}, but the current ${sideEn} entry is late. ${retestTextEn} Price is in a poor entry area${resistanceText}, and R/R is only ${rr} versus the required 1.8, so there is no active trade.${requiredText}`;
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
