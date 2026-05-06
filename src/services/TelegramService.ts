// src/services/TelegramService.ts

import TelegramBot, { Message } from 'node-telegram-bot-api';
import { DatabaseService, LiquidationData, LiquidationSummary, UserStats } from './DatabaseService';
import { ReportingService } from './ReportingService';
import { MarketDataService, OISurge } from './MarketDataService';
import { SYMBOLS_TO_TRACK, TELEGRAM_CHANNEL_ID, CHANNEL_MIN_LIQUIDATION, TELEGRAM_ADMIN_IDS } from '../config';
import { AnalysisService } from '../analysis/AnalysisService';
import { AnalysisResult } from '../analysis/types';

type UserState = 'awaiting_threshold';
const PAIRS_PAGE_SIZE = 30;

// Определение типа CascadeBuffer
export type CascadeBuffer = {
    count: number;
    totalVolume: number;
    minPrice: number;
    maxPrice: number;
    side: 'long' | 'short';
    startTime: number;
};

export type AggregatedLiquidationAlert = {
    symbol: string;
    side: 'long' | 'short';
    count: number;
    totalVolume: number;
    minPrice: number;
    maxPrice: number;
    firstPrice: number;
    lastPrice: number;
    startTime: number;
    endTime: number;
    windowSeconds: number;
};

export type DisbalanceAlert = {
    symbol: string;
    longs: number;
    shorts: number;
    ratio: number;
    windowMinutes: number;
};

export type SystemStatus = {
    uptimeSeconds: number;
    listener: {
        trackedSymbols: number;
        activeSockets: number;
        socketStates: Record<string, number>;
        messagesReceived: number;
        liquidationsProcessed: number;
        pendingAggregates: number;
        pendingCascades: number;
        aggregatesSent: number;
        cascadesSent: number;
        disbalanceAlertsSent: number;
        lastLiquidationAt: string | null;
    };
    db: {
        users: UserStats;
        lastLiquidations: LiquidationData[];
    };
    thresholds: {
        channelMinLiquidation: number;
    };
};

export class TelegramService {
    private bot: TelegramBot;
    private dbService: DatabaseService;
    private reportingService: ReportingService;
    private marketDataService: MarketDataService;
    private analysisService: AnalysisService;
    private readonly reportIntervals = [1, 4, 12, 24];
    private userStates: Map<number, UserState> = new Map();
    private statusProvider?: () => Promise<SystemStatus>;

    constructor(
        token: string,
        dbService: DatabaseService,
        reportingService: ReportingService,
        marketDataService: MarketDataService,
        analysisService: AnalysisService
    ) {
        this.bot = new TelegramBot(token, { polling: true });
        this.dbService = dbService;
        this.reportingService = reportingService;
        this.marketDataService = marketDataService;
        this.analysisService = analysisService;
        this.listenForCommands();
        console.log(`✅ TelegramService initialized. Channel Mode: ${TELEGRAM_CHANNEL_ID ? 'ON' : 'OFF'}`);
    }

    public setStatusProvider(provider: () => Promise<SystemStatus>): void {
        this.statusProvider = provider;
    }

    public async stop(): Promise<void> {
        await this.bot.stopPolling();
        console.log('✅ Telegram polling stopped.');
    }

    private listenForCommands(): void {
        this.bot.onText(/\/start/, this.handleStart.bind(this));
        
        // Меню (Кнопки)
        this.bot.onText(/📢 Report Now/, this.handleReportNow.bind(this));
        this.bot.onText(/📊 Market Stats/, this.handleMarketStats.bind(this));
        this.bot.onText(/⚡ TOP Funding/, this.handleTopFunding.bind(this));
        this.bot.onText(/💸 Tracked Pairs/, this.handleTrackedPairs.bind(this));
        this.bot.onText(/📊 Open Interest/, this.handleOIMenu.bind(this));
        this.bot.onText(/⚙️ Settings/, this.handleSettings.bind(this));

        // Текстовые команды
        this.bot.onText(/\/status/, this.handleStatus.bind(this));
        this.bot.onText(/\/analyze (.+)/, this.handleAnalyze.bind(this));
        this.bot.onText(/\/oi (.+)/, this.handleOpenInterest.bind(this));
        this.bot.onText(/\/ratio (.+)/, this.handleRatio.bind(this));

        // Обработчики событий
        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
        this.bot.on('message', this.handleMessage.bind(this));
    }

    // --- UTILS: SPARKLINES ---
    private generateSparkline(data: number[]): string {
        if (!data || data.length === 0) return '';
        const ticks = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
        const min = Math.min(...data);
        const max = Math.max(...data);
        const range = max - min;
        
        return data.map(v => {
            if (range === 0) return ticks[3];
            const index = Math.min(Math.round(((v - min) / range) * (ticks.length - 1)), ticks.length - 1);
            return ticks[index];
        }).join('');
    }

    private formatCompactMoney(value: number): string {
        if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
        if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
        if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
        return `$${value.toFixed(0)}`;
    }

    private formatUptime(seconds: number): string {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }

    private formatPositioning(ratio: number): string {
        if (ratio >= 2.5) return `Overlong ${ratio.toFixed(2)}x`;
        if (ratio >= 1.5) return `Long-biased ${ratio.toFixed(2)}x`;
        if (ratio <= 0.5) return `Overshort ${(1 / ratio).toFixed(2)}x`;
        if (ratio <= 0.7) return `Short-biased ${(1 / ratio).toFixed(2)}x`;
        return `Neutral ${ratio.toFixed(2)}x`;
    }

    private formatAnalysisResult(result: AnalysisResult, locale: 'ru' | 'en' = 'en'): string {
        const decisionIcon = result.decision === 'LONG' ? '🟢' : result.decision === 'SHORT' ? '🔴' : '⚪';
        const escape = (value: string | number) => String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const t = this.getAnalysisLabels(locale);
        const clean = (value: string) => value.replace(/_/g, ' ');
        const shorten = (value: string, max: number) => this.shortenText(value, max);
        const entry = this.formatEntryZone(result, locale);
        const takeProfits = result.riskManagement.takeProfit.length
            ? result.riskManagement.takeProfit.join(' / ')
            : 'n/a';
        const tradePlan = result.decision === 'WAIT'
            ? `<b>${t.tradePlan}</b>\n` +
              `${t.entryStatus}: <b>${escape(this.getEntryStatusText(result, locale))}</b>\n` +
              `${escape(this.buildTradePlanStatusLines(result, locale))}` +
              `${t.noActiveSetup} <b>${escape(result.entry.currentPrice)}</b>\n` +
              `${this.getReferenceZoneLabel(result, locale)}: ${escape(entry)}\n` +
              `${escape(this.buildReferenceZoneStatus(result, locale))}` +
              `${escape(shorten(this.localizeWaitEntryComment(result, locale) || t.noEntryWhileWait, 180))}\n\n`
            : `<b>${t.entry}</b>\n` +
              `${t.zone}: <b>${escape(entry)}</b>\n` +
              `${t.current}: <b>${escape(result.entry.currentPrice)}</b>\n\n` +
              `<b>${t.riskManagement}</b>\n` +
              `${t.stop}: <b>${escape(result.riskManagement.stopLoss || 'n/a')}</b>\n` +
              `TP: <b>${escape(takeProfits)}</b>\n` +
              `R/R: <b>${escape(result.riskManagement.riskReward || 'n/a')}</b>\n` +
              `Invalidation: <i>${escape(result.riskManagement.invalidation || result.riskManagement.reason || 'n/a')}</i>\n\n`;
        const warnings = this.buildLocalizedWarnings(result, locale).slice(0, 3).map(item => `• ${escape(item)}`).join('\n') || '• No major warnings.';
        const scoreBreakdown = result.categoryScores
            .filter(item => ['HTF_CONTEXT', 'MARKET_STRUCTURE_4H', 'BTC_DOMINANCE', 'DERIVATIVES', 'CVD_DELTA', 'RISK_REWARD'].includes(item.category))
            .map(item => `${item.category.replace(/_/g, ' ')} ${item.score > 0 ? '+' : ''}${item.score}/${item.max}`)
            .join(' | ');
        const altMarketFilter = this.formatAltMarketFilter(result, locale);
        const nextConditions = this.buildLocalizedScenarios(result, locale).slice(0, 3).map(item => `• ${escape(shorten(item, 240))}`).join('\n') || '• No specific trigger yet.';
        const whyNotNow = this.buildLocalizedWhyNotNow(result, locale)
            .slice(0, 5)
            .map(item => `• ${escape(shorten(item, 160))}`)
            .join('\n') || `• ${locale === 'ru' ? 'Блокирующих причин не найдено.' : 'No blocking reason detected.'}`;
        const tradeConfidence = result.tradeConfidence === null
            ? t.tradeConfidenceNa
            : `${result.tradeConfidence}%`;
        const directionalBiasLabel = this.getDirectionalBiasTitle(result, locale, t.directionalBias);

        return `${decisionIcon} <b>${escape(result.symbol)} MTF Analysis — 4H Setup</b>\n\n` +
               `${t.decision}: <b>${escape(result.decision)}</b>\n` +
               `${directionalBiasLabel}: <b>${escape(this.getBiasLabel(result, locale))} ${result.directionScore}/100</b>\n` +
               `${t.setupQuality}: <b>${escape(result.setupQuality)} ${result.setupQualityScore}/100</b>\n` +
               `${t.riskScore}: <b>${escape(result.riskScore)}/100</b>\n` +
               `${t.tradeConfidence}: <b>${escape(tradeConfidence)}</b>\n\n` +
               `<b>${t.methodology}</b>\n${escape(t.methodologyText)}\n\n` +
               `${tradePlan}` +
               `<b>${t.whyNotNow}</b>\n${whyNotNow}\n\n` +
               `<b>${t.requiredEntry}</b>\n${escape(shorten(this.buildLocalizedRequiredEntry(result, locale), 260))}\n\n` +
               `<b>${t.marketState}</b>\n` +
               `${t.regime}: ${escape(this.buildRegimeText(result, locale))}\n` +
               `${locale === 'ru' ? 'HTF-контекст' : 'HTF Context'}: 1W ${escape(result.marketState.weeklyTrend)} | 1D ${escape(result.marketState.dailyTrend)}\n` +
               `4H: ${escape(clean(result.marketState.h4Trend))} | 1H: ${escape(result.marketState.h1Trend)}\n` +
               `BTC: 1D ${escape(result.marketState.btcDailyTrend)}, 4H ${escape(result.marketState.btcH4Trend)}\n` +
               `${altMarketFilter ? `${escape(altMarketFilter)}\n` : ''}` +
               `${t.scores}: ${escape(scoreBreakdown)}\n\n` +
               `<b>${t.context}</b>\n` +
               `${escape(this.localizeVolume(result.analysis.volume, locale))}\n` +
               `${escape(this.localizeRetestStatus(result, locale))}\n` +
               `${escape(this.formatTriggerCandleContext(result, locale))}\n` +
               `${escape(result.analysis.orderFlow)}\n` +
               `${escape(this.formatDerivativesContext(result.analysis.derivatives))}\n\n` +
               `<b>${this.getOiContextLabel(result, locale)}</b>\n${escape(shorten(this.stripOiWarningPrefix(result.analysis.oiWarning), 320))}\n\n` +
               `<b>${t.warnings}</b>\n${warnings}\n\n` +
               `<b>${t.setupScenarios}</b>\n${nextConditions}\n\n` +
               `<i>Rule-based MVP. Not financial advice.</i>`;
    }

    private formatAnalysisSummary(result: AnalysisResult, locale: 'ru' | 'en' = 'en'): string {
        const escape = (value: string | number) => String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const t = this.getAnalysisLabels(locale);
        const summary = this.sanitizeReportText(result.aiSummary || result.mainReason);

        return `<b>${t.summary}: ${escape(result.symbol)}</b>\n\n` +
               `${escape(summary)}\n\n` +
               `<b>${t.currentAction}</b>\n${escape(this.buildLocalizedAction(result, locale))}`;
    }

    private getAnalysisLabels(locale: 'ru' | 'en') {
        if (locale === 'ru') {
            return {
                decision: 'Решение',
                directionalBias: 'Технический bias',
                setupQuality: 'Качество входа',
                riskScore: 'Качество риска',
                tradeConfidence: 'Уверенность сделки',
                tradeConfidenceNa: 'N/A - нет валидной сделки при WAIT',
                methodology: 'Методология',
                methodologyText: 'MTF-анализ с 4H execution-сценарием. 1W/1D дают старший контекст; 4H — структуру, уровни, объём, ATR, R/R и триггеры; 1H — локальное подтверждение. BTC, BTC.D и USDT.D используются как market filters. Финальное решение формируется только по закрытой 4H-свече; live price используется для текущей цены, R/R, статуса входа и расстояния до уровней.',
                summary: 'Кратко',
                currentAction: 'Текущее действие',
                tradePlan: 'План сделки',
                entryStatus: 'Статус входа',
                noActiveSetup: 'Активной сделки нет. Текущая цена:',
                missedRetestZone: 'Пропущенная зона ретеста',
                referenceZone: 'Reference-зона',
                noEntryWhileWait: 'Нет entry/SL/TP пока decision = WAIT.',
                entry: 'Entry',
                zone: 'Zone',
                current: 'Current',
                riskManagement: 'Risk Management',
                stop: 'Stop',
                whyNotNow: 'Почему не входим сейчас',
                requiredEntry: 'Что нужно для R/R >= 1.8',
                marketState: 'Состояние рынка',
                context: 'Контекст',
                oiWarning: 'OI-предупреждение',
                warnings: 'Предупреждения',
                setupScenarios: 'Сценарии',
                regime: 'Локальный режим 4H/1H',
                scores: 'Scores'
            };
        }

        return {
            decision: 'Decision',
            directionalBias: 'Technical Directional Bias',
            setupQuality: 'Trade Setup Quality',
            riskScore: 'Risk Score',
            tradeConfidence: 'Trade Confidence',
            tradeConfidenceNa: 'N/A - no valid trade setup while decision is WAIT',
            methodology: 'Methodology',
            methodologyText: 'MTF analysis with a 4H execution scenario. 1W/1D provide higher-timeframe context; 4H drives structure, levels, volume, ATR, R/R and triggers; 1H is only local confirmation. BTC, BTC.D and USDT.D are market filters. Final decision is based only on closed 4H candles; live price is used for current price, R/R, entry status and level distance.',
            summary: 'Summary',
            currentAction: 'Current Action',
            tradePlan: 'Trade Plan',
            entryStatus: 'Entry Status',
            noActiveSetup: 'No active trade setup. Current price:',
            missedRetestZone: 'Missed Retest Zone',
            referenceZone: 'Reference Zone',
            noEntryWhileWait: 'No entry/SL/TP while decision is WAIT.',
            entry: 'Entry',
            zone: 'Zone',
            current: 'Current',
            riskManagement: 'Risk Management',
            stop: 'Stop',
            whyNotNow: 'Why Not Now',
            requiredEntry: 'Required Entry For Valid R/R',
            marketState: 'Market State',
            context: 'Context',
            oiWarning: 'OI Warning',
            warnings: 'Warnings',
            setupScenarios: 'Setup Scenarios',
            regime: 'Local 4H/1H Regime',
            scores: 'Scores'
        };
    }

    private sanitizeReportText(text: string): string {
        return text
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/#{1,6}\s?/g, '')
            .replace(/`/g, '')
            .replace(/^\s*[-•]\s+/gm, '')
            .trim();
    }

    private shortenText(value: string, max: number): string {
        if (value.length <= max) return value;
        const slice = value.slice(0, max - 3);
        const sentenceEnd = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
        if (sentenceEnd > max * 0.55) return slice.slice(0, sentenceEnd + 1);
        const lastSpace = slice.lastIndexOf(' ');
        return `${slice.slice(0, lastSpace > 0 ? lastSpace : max - 3)}...`;
    }

    private stripOiWarningPrefix(text: string): string {
        return text
            .replace(/^OI Warning:\s*/i, '')
            .replace(/^OI:\s*/i, '');
    }

    private getBiasLabel(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const score = result.directionScore;
        if (score > 0 && score < 50) return locale === 'ru' ? 'СЛАБО БЫЧИЙ' : 'WEAK BULLISH';
        if (score < 0 && score > -50) return locale === 'ru' ? 'СЛАБО МЕДВЕЖИЙ' : 'WEAK BEARISH';
        if (score >= 50 && score < 70) return locale === 'ru' ? 'УМЕРЕННО БЫЧИЙ' : 'MODERATELY BULLISH';
        if (score <= -50 && score > -70) return locale === 'ru' ? 'УМЕРЕННО МЕДВЕЖИЙ' : 'MODERATELY BEARISH';
        if (result.primaryScenario === 'LONG' && result.marketState.weeklyTrend === 'DOWNTREND') {
            return locale === 'ru' ? 'ЛОКАЛЬНО BULLISH' : 'LOCALLY BULLISH';
        }
        if (result.primaryScenario === 'SHORT' && result.marketState.weeklyTrend === 'UPTREND') {
            return locale === 'ru' ? 'ЛОКАЛЬНО BEARISH' : 'LOCALLY BEARISH';
        }
        return result.bias;
    }

    private getDirectionalBiasTitle(result: AnalysisResult, locale: 'ru' | 'en', fallback: string): string {
        const localLongAgainstWeekly = result.primaryScenario === 'LONG' && result.marketState.weeklyTrend === 'DOWNTREND';
        const localShortAgainstWeekly = result.primaryScenario === 'SHORT' && result.marketState.weeklyTrend === 'UPTREND';
        if (!localLongAgainstWeekly && !localShortAgainstWeekly) return fallback;
        return locale === 'ru' ? 'Локальный технический bias' : 'Local Technical Bias';
    }

    private getOiContextLabel(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const isWarning = /^OI Warning:/i.test(result.analysis.oiWarning);
        if (locale === 'ru') return isWarning ? 'OI-предупреждение' : 'OI-контекст';
        return isWarning ? 'OI Warning' : 'OI Context';
    }

    private buildRegimeText(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const regime = result.marketRegime.replace(/_/g, ' ');
        const volumeRatio = this.extractVolumeRatio(result);
        if (result.marketRegime === 'EXPANSION' && volumeRatio < 1.5) {
            return locale === 'ru'
                ? `${regime} по волатильности, но без объёмного breakout-confirmation`
                : `${regime} by volatility, but without volume breakout confirmation`;
        }
        return regime;
    }

    private formatAltMarketFilter(result: AnalysisResult, locale: 'ru' | 'en'): string | undefined {
        if (result.symbol === 'BTCUSDT') return undefined;
        const btcDominanceScore = result.categoryScores.find(item => item.category === 'BTC_DOMINANCE')?.score;
        const scoreText = btcDominanceScore !== undefined ? ` (${btcDominanceScore > 0 ? '+' : ''}${btcDominanceScore}/10)` : '';
        if (locale !== 'ru') return `Altcoin Market Filter: ${result.analysis.altMarketFilter}${scoreText}`;

        return `Altcoin Market Filter: ${this.localizeAltMarketFilter(result.analysis.altMarketFilter)}${scoreText}`;
    }

    private localizeAltMarketFilter(text: string): string {
        const match = text.match(/^BTC\.D ([0-9.]+)%, trend ([A-Z_]+), slope ([A-Z_]+), 4h change ([+-][0-9.]+) pp, position ([A-Z_]+), breakout ([A-Z_]+): (.+)$/);
        if (match) {
            const [, value, trend, slope, changeRaw, position, breakout, reason] = match;
            const change = Number(changeRaw);
            const direction = change > 0.02
                ? 'растёт'
                : change < -0.02
                    ? 'падает'
                    : 'без явного изменения';
            return `BTC.D ${value}%, trend ${trend}, slope ${slope}, 4h ${direction} (${changeRaw} п.п.), position ${position}, breakout ${breakout}: ${this.localizeAltMarketFilterReason(reason)}`;
        }

        return this.localizeAltMarketFilterReason(text);
    }

    private localizeAltMarketFilterReason(text: string): string {
        return text
            .replace('supportive alt-long regime; BTC.D falling while BTC is stable/strong', 'поддерживает alt-long: BTC.D падает, BTC стабильный/сильный')
            .replace('bearish alt regime; BTC.D rising with weak BTC pressures alts', 'негативный режим для альтов: BTC.D растёт при слабом BTC')
            .replace('mild pressure on alt-long because BTC may outperform', 'умеренное давление на alt-long: BTC может outperform альты')
            .replace('BTC may outperform alts; alt-long needs stronger confirmation', 'BTC может outperform альты; alt-long требует сильнее подтверждения')
            .replace('supportive alt regime because BTC.D breaks down while BTC is strong', 'поддерживает альты: BTC.D пробивается вниз при сильном BTC')
            .replace('BTC.D supports alts, but weak BTC keeps market risk elevated', 'BTC.D поддерживает альты, но слабый BTC оставляет рыночный риск')
            .replace('BTC.D falling helps alts, but BTC weakness keeps risk mixed', 'падение BTC.D помогает альтам, но слабый BTC оставляет смешанный риск')
            .replace('mild risk-on for alts as BTC.D rejects from resistance', 'мягкий risk-on для альтов: BTC.D отклоняется от сопротивления')
            .replace('mild pressure on alts as BTC.D bounces from support', 'умеренное давление на альты: BTC.D отскакивает от поддержки')
            .replace('neutral alt market filter', 'нейтральный фильтр для альтов')
            .replace('strong pressure on alts because BTC.D is breaking up while BTC is weak', 'сильное давление на альты: BTC.D пробивается вверх при слабом BTC');
    }

    private buildTradePlanStatusLines(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const lines: string[] = [];
        const retestStatus = result.analysis.retestStatus.toLowerCase();
        if (retestStatus.includes('pending')) {
            const referenceZone = this.formatEntryZone(result, locale);
            if (locale === 'ru') {
                lines.push(result.primaryScenario === 'LONG'
                    ? `Pullback Retest Status: ОЖИДАЕТСЯ. Цена должна вернуться в long-зону ${referenceZone} и показать bullish reaction.`
                    : `Pullback Retest Status: ОЖИДАЕТСЯ. Цена должна вернуться в short-зону ${referenceZone} и показать rejection.`);
                lines.push('Breakout Retest Status: NOT AVAILABLE. Сначала нужно подтверждённое закрытие 4H за breakout-уровнем.');
            } else {
                lines.push(result.primaryScenario === 'LONG'
                    ? `Pullback Retest Status: PENDING. Price must return to long zone ${referenceZone} and print bullish reaction.`
                    : `Pullback Retest Status: PENDING. Price must return to short zone ${referenceZone} and print rejection.`);
                lines.push('Breakout Retest Status: NOT AVAILABLE. A confirmed 4H close beyond the breakout level is required first.');
            }
        }

        const breakoutStatus = this.buildBreakoutStatus(result, locale);
        if (breakoutStatus) lines.push(breakoutStatus);
        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    private buildBreakoutStatus(result: AnalysisResult, locale: 'ru' | 'en'): string | undefined {
        if (result.primaryScenario === 'NEUTRAL') return undefined;
        const level = result.riskManagement.nearestBlockingLevel;
        if (!level) return undefined;

        const volumeRatio = this.extractVolumeRatio(result);
        const isLong = result.primaryScenario === 'LONG';
        const priceNotThroughLevel = isLong
            ? result.entry.currentPrice < level
            : result.entry.currentPrice > level;
        const volumeNotEnough = volumeRatio > 0 && volumeRatio < 1.5;
        if (!priceNotThroughLevel && !volumeNotEnough) return undefined;

        if (locale === 'ru') {
            const priceReason = priceNotThroughLevel
                ? isLong ? `цена ниже сопротивления ${level}` : `цена выше поддержки ${level}`
                : undefined;
            const volumeReason = volumeNotEnough ? `объём ${volumeRatio.toFixed(2)}x < требуемых 1.5x` : undefined;
            return `Breakout Status: NOT ACTIVATED. Причина: ${[priceReason, volumeReason].filter(Boolean).join(', ')}.`;
        }

        const priceReason = priceNotThroughLevel
            ? isLong ? `price is below resistance ${level}` : `price is above support ${level}`
            : undefined;
        const volumeReason = volumeNotEnough ? `volume ${volumeRatio.toFixed(2)}x < required 1.5x` : undefined;
        return `Breakout Status: NOT ACTIVATED. Reason: ${[priceReason, volumeReason].filter(Boolean).join(', ')}.`;
    }

    private formatEntryZone(result: AnalysisResult, locale: 'ru' | 'en', separator: string = locale === 'ru' ? ' - ' : ' - '): string {
        if (result.entry.from === undefined || result.entry.to === undefined) return 'No trade zone';
        const from = Math.min(result.entry.from, result.entry.to);
        const to = Math.max(result.entry.from, result.entry.to);
        return `${from}${separator}${to}`;
    }

    private retestLevelInsideEntryZone(result: AnalysisResult): boolean {
        const level = result.riskManagement.retestLevel;
        if (level === undefined || result.entry.from === undefined || result.entry.to === undefined) return false;
        const from = Math.min(result.entry.from, result.entry.to);
        const to = Math.max(result.entry.from, result.entry.to);
        return level >= from && level <= to;
    }

    private getReferenceZoneLabel(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (result.riskManagement.missedRetestEntry) {
            return locale === 'ru' ? 'Пропущенная reference-зона' : 'Missed Reference Zone';
        }
        if (result.riskSide === 'SHORT') {
            return locale === 'ru' ? 'Зона потенциального short-входа' : 'Short Reference Zone';
        }
        if (result.riskSide === 'LONG') {
            return locale === 'ru' ? 'Зона потенциального long-входа' : 'Long Reference Zone';
        }
        return locale === 'ru' ? 'Reference-зона' : 'Reference Zone';
    }

    private buildReferenceZoneStatus(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (!result.riskManagement.requiredEntryForMinRr || result.entry.from === undefined || result.entry.to === undefined) return '';
        const required = result.riskManagement.requiredEntryForMinRr;
        const zoneLow = Math.min(result.entry.from, result.entry.to);
        const zoneHigh = Math.max(result.entry.from, result.entry.to);
        const invalidForLong = result.riskSide === 'LONG' && required < zoneLow;
        const invalidForShort = result.riskSide === 'SHORT' && required > zoneHigh;
        if (!invalidForLong && !invalidForShort) return '';

        if (locale === 'ru') {
            const sideText = result.riskSide === 'LONG'
                ? `Для валидного long по текущей геометрии нужен вход <= ${required}.`
                : `Для валидного short по текущей геометрии нужен вход >= ${required}.`;
            const proximityText = result.entry.currentPrice >= zoneLow && result.entry.currentPrice <= zoneHigh + Math.abs(zoneHigh - zoneLow) * 0.35
                ? ` Хотя цена близко к reference-зоне, вход ${result.riskSide === 'LONG' ? `выше ${required}` : `ниже ${required}`} уже не даёт требуемый R/R.`
                : '';
            return `Статус reference-зоны: НЕВАЛИДНА ПО ТЕКУЩЕМУ R/R. ${sideText}${proximityText}\n`;
        }

        const sideText = result.riskSide === 'LONG'
            ? `Valid long currently needs entry <= ${required}.`
            : `Valid short currently needs entry >= ${required}.`;
        const proximityText = result.entry.currentPrice >= zoneLow && result.entry.currentPrice <= zoneHigh + Math.abs(zoneHigh - zoneLow) * 0.35
            ? ` Although price is close to the reference zone, entry ${result.riskSide === 'LONG' ? `above ${required}` : `below ${required}`} no longer provides required R/R.`
            : '';
        return `Reference zone status: INVALID BY CURRENT R/R. ${sideText}${proximityText}\n`;
    }

    private buildLocalizedAction(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (result.primaryScenario === 'NEUTRAL') {
            if (locale === 'ru') {
                return `Сделки нет.\n\nLong валиден только если:\n• 4H выходит из RANGE вверх и закрепляется над ключевым уровнем.\n• После пробоя есть ретест уровня как поддержки.\n• R/R после ретеста >= 1.8.\n• CVD разворачивается вверх, delta положительная.\n• BTC остаётся сильным, USDT.D не показывает risk-off.\n\nShort валиден только если:\n• Цена получает rejection от верхней границы диапазона/сопротивления или делает breakdown/retest.\n• R/R >= 1.8.\n• CVD остаётся DOWN или delta становится отрицательной.\n• Funding/top trader long bias остаются перегретыми.\n• USDT.D растёт или показывает risk-off.`;
            }

            return `No trade.\n\nLong valid only if:\n• 4H exits RANGE upward and closes above a key level.\n• Breakout is followed by support retest.\n• R/R after retest is >= 1.8.\n• CVD turns UP and delta is positive.\n• BTC remains strong and USDT.D does not show risk-off.\n\nShort valid only if:\n• Price rejects upper range/resistance or prints breakdown/retest.\n• R/R >= 1.8.\n• CVD stays DOWN or delta turns negative.\n• Funding/top-trader long bias stays overheated.\n• USDT.D rises or shows risk-off.`;
        }

        const isLong = result.primaryScenario === 'LONG';
        const breakoutLevel = result.riskManagement.nearestBlockingLevel;
        const requiredEntry = result.riskManagement.requiredEntryForMinRr;

        if (locale === 'ru') {
            const pullback = requiredEntry
                ? isLong
                    ? `Цена возвращается в зону, где расчётный R/R >= 1.8. По текущей long-геометрии это не выше ${requiredEntry}.`
                    : `Цена возвращается в зону, где расчётный R/R >= 1.8. По текущей short-геометрии это не ниже ${requiredEntry}.`
                : 'Цена возвращается в зону, где расчётный R/R >= 1.8.';
            const breakout = breakoutLevel
                ? isLong
                    ? `4H закрывается выше ${breakoutLevel}, затем уровень ретестится как поддержка.`
                    : `4H закрывается ниже ${breakoutLevel}, затем уровень ретестится как сопротивление.`
                : '4H пробивает ключевой уровень, затем уровень ретестится.';
            const cvdNeedsTurn = isLong && !result.analysis.orderFlow.includes('CVD UP');
            const cvd = isLong
                ? cvdNeedsTurn
                    ? 'CVD должен развернуться вверх, delta стать положительной, bearish divergence не должна появиться.'
                    : 'CVD продолжает расти, delta остаётся положительной, bearish divergence не появляется.'
                : 'CVD остаётся DOWN или delta становится отрицательной, bullish divergence не появляется.';
            const usdt = isLong
                ? 'USDT.D не пробивает диапазон вверх и не показывает risk-off ускорение.'
                : 'USDT.D растёт или подтверждает risk-off ускорение.';
            return `Сделки нет.\n\n${isLong ? 'Long' : 'Short'} валиден только если:\n• ${pullback}\n• Или ${breakout}\n• ${cvd}\n• ${usdt}`;
        }

        const pullback = requiredEntry
            ? isLong
                ? `Pullback gives R/R >= 1.8 at or below ${requiredEntry}.`
                : `Pullback gives R/R >= 1.8 at or above ${requiredEntry}.`
            : 'Pullback gives R/R >= 1.8.';
        const breakout = breakoutLevel
            ? isLong
                ? `4H closes above ${breakoutLevel}, then retests it as support.`
                : `4H closes below ${breakoutLevel}, then retests it as resistance.`
            : '4H breaks the key level, then retests it.';
        const cvdNeedsTurn = isLong && !result.analysis.orderFlow.includes('CVD UP');
        const cvd = isLong
            ? cvdNeedsTurn
                ? 'CVD must turn UP, delta must become positive, and bearish divergence must not appear.'
                : 'CVD keeps rising, delta stays positive, and bearish divergence does not appear.'
            : 'CVD stays DOWN or delta turns negative, and bullish divergence does not appear.';
        const usdt = isLong
            ? 'USDT.D does not break upward or show risk-off acceleration.'
            : 'USDT.D rises or confirms risk-off acceleration.';
        return `No trade.\n\nValid ${isLong ? 'Long' : 'Short'} Only If:\n• ${pullback}\n• Or ${breakout}\n• ${cvd}\n• ${usdt}`;
    }

    private getEntryStatusText(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const status = result.riskManagement.currentEntryStatus || 'NO_TRADE';
        if (locale === 'ru') {
            if (result.primaryScenario === 'NEUTRAL') return 'НЕТ DIRECTIONAL EDGE';
            if (status === 'MISSED_RETEST') return 'ПРОПУЩЕН';
            if (status === 'TOO_LATE' && result.riskSide === 'SHORT') return 'НИЖЕ SHORT-ЗОНЫ';
            if (status === 'TOO_LATE' && result.riskSide === 'LONG') return 'ВЫШЕ LONG-ЗОНЫ';
            if (status === 'VALID') return 'ВАЛИДЕН';
            if (status === 'WAITING_RETEST') return 'ОЖИДАЕТ РЕТЕСТ';
            return 'НЕТ СДЕЛКИ';
        }
        if (status === 'TOO_LATE' && result.riskSide === 'SHORT') return 'BELOW SHORT ZONE';
        if (status === 'TOO_LATE' && result.riskSide === 'LONG') return 'ABOVE LONG ZONE';
        return status.replace(/_/g, ' ');
    }

    private localizeWaitEntryComment(result: AnalysisResult, locale: 'ru' | 'en'): string | undefined {
        if (result.riskManagement.retestEntryComment) {
            if (locale !== 'ru') return result.riskManagement.retestEntryComment;
            const level = result.riskManagement.retestLevel;
            const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
            const entryZone = this.formatEntryZone(result, locale);
            const direction = result.riskSide === 'LONG' ? 'выше' : 'ниже';
            if (!this.retestLevelInsideEntryZone(result)) {
                return `Локальная реакция была около ${level || 'уровня'}, после чего цена ушла ${direction} reference-зоны ${entryZone}, а R/R ухудшился до ${rr}.`;
            }
            return `Ретест reference-зоны был подтверждён около ${level || 'уровня'}, после чего цена ушла ${direction} зоны входа, а R/R ухудшился до ${rr}.`;
        }

        const status = result.riskManagement.currentEntryStatus;
        const entry = result.entry.from && result.entry.to ? this.formatEntryZone(result, locale) : undefined;
        if (status === 'TOO_LATE' && result.riskSide === 'SHORT') {
            return locale === 'ru'
                ? `Текущая цена ниже зоны потенциального short-входа${entry ? ` ${entry}` : ''}, поэтому вход с текущей цены хуже по R/R.`
                : `Current price is below the potential short-entry zone${entry ? ` ${entry}` : ''}, so short entry from here has worse R/R.`;
        }
        if (status === 'TOO_LATE' && result.riskSide === 'LONG') {
            return locale === 'ru'
                ? `Текущая цена выше зоны потенциального long-входа${entry ? ` ${entry}` : ''}, поэтому вход с текущей цены хуже по R/R.`
                : `Current price is above the potential long-entry zone${entry ? ` ${entry}` : ''}, so long entry from here has worse R/R.`;
        }
        return undefined;
    }

    private formatDerivativesContext(text: string): string {
        const oiIndex = text.indexOf('. OI ');
        const firstOiSentenceIndex = text.indexOf('. Price ');
        const cutIndex = [oiIndex, firstOiSentenceIndex]
            .filter(index => index >= 0)
            .sort((a, b) => a - b)[0];
        return cutIndex !== undefined ? text.slice(0, cutIndex).trim() + '.' : text;
    }

    private localizeRetestEntryComment(result: AnalysisResult, locale: 'ru' | 'en'): string | undefined {
        if (!result.riskManagement.retestEntryComment) return undefined;
        if (locale !== 'ru') return result.riskManagement.retestEntryComment;
        const level = result.riskManagement.retestLevel;
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        const direction = result.riskSide === 'LONG' ? 'выше' : 'ниже';
        const entryZone = this.formatEntryZone(result, locale);
        if (!this.retestLevelInsideEntryZone(result)) {
            return `Локальная реакция была около ${level || 'уровня'}, после чего цена ушла ${direction} reference-зоны ${entryZone}, а R/R ухудшился до ${rr}.`;
        }
        return `Ретест reference-зоны был подтверждён около ${level || 'уровня'}, после чего цена ушла ${direction === 'выше' ? 'выше зоны входа' : 'ниже зоны входа'}, а R/R ухудшился до ${rr}.`;
    }

    private localizeVolume(text: string, locale: 'ru' | 'en'): string {
        if (locale !== 'ru') return text;
        const ratio = text.match(/([0-9.]+)x average/)?.[1] || 'n/a';
        const signal = text.match(/\(([^)]+)\)/)?.[1] || 'NORMAL';
        const trend = text.match(/trend ([A-Z]+)/)?.[1] || 'FLAT';
        return `4H объём ${ratio}x от среднего (${signal}), тренд ${trend}.`;
    }

    private localizeRetestStatus(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (locale !== 'ru') return result.analysis.retestStatus;
        if (result.riskManagement.missedRetestEntry) {
            const level = result.riskManagement.retestLevel || 'уровня';
            const direction = result.riskSide === 'LONG' ? 'выше зоны входа' : 'ниже зоны входа';
            if (!this.retestLevelInsideEntryZone(result)) {
                return `Статус ретеста: не подтверждён для текущей reference-зоны. Локальная реакция подтверждена около ${level}, после чего цена ушла ${direction}.`;
            }
            return `Статус ретеста: подтверждён для текущей reference-зоны, но вход пропущен. Реакция была около ${level}, после чего цена ушла ${direction}.`;
        }
        return result.analysis.retestStatus.replace('Retest Status:', 'Статус ретеста:');
    }

    private localizeTriggerCandle(text: string, locale: 'ru' | 'en'): string {
        if (locale !== 'ru') return text;
        return text
            .replace('bullish rejection from lower prices', 'бычий откуп от нижних цен')
            .replace('bearish rejection from higher prices', 'медвежий отказ от верхних цен')
            .replace('body', 'тело')
            .replace('close location', 'закрытие в диапазоне')
            .replace('volume', 'объём');
    }

    private formatTriggerCandleContext(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const trigger = result.analysis.triggerCandle.toLowerCase();
        const volumeRatio = this.extractVolumeRatio(result);
        if (trigger.includes('weak trigger')) {
            return this.buildWeakTriggerWarning(result, volumeRatio, locale);
        }
        return this.localizeTriggerCandle(result.analysis.triggerCandle, locale);
    }

    private buildLocalizedWarnings(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.warnings;

        const warnings: string[] = [];
        if (result.riskManagement.nearestBlockingLevel) {
            const levelText = result.riskSide === 'LONG' ? 'Ближайшее сопротивление' : 'Ближайшая поддержка';
            warnings.push(`${levelText} ${result.riskManagement.nearestBlockingLevel} ограничивает потенциальный TP-path; при WAIT активный TP не выставляется.`);
        }
        if (result.primaryScenario === 'LONG' && result.setupReason.includes('premium')) {
            warnings.push('Long находится в premium-зоне, риск догонять цену повышен.');
        }
        if (result.primaryScenario === 'SHORT' && result.setupReason.includes('discount')) {
            warnings.push('Short находится в discount-зоне, риск догонять цену повышен.');
        }
        if (result.primaryScenario === 'NEUTRAL') {
            warnings.push('Нет активной стороны сделки: long и short требуют отдельных подтверждений.');
        } else {
            const volumeRatio = this.extractVolumeRatio(result);
            const closeLocationText = this.describeTriggerCloseLocation(result, locale);
            const noBreakout = result.marketState.h4Trend === 'RANGE' || result.analysis.marketStructure.includes('BOS NONE');
            const trigger = result.analysis.triggerCandle.toLowerCase();
            const triggerIsStrong = trigger.includes('strong trigger');
            const triggerIsAcceptable = trigger.includes('acceptable trigger');
            if (trigger.includes('weak trigger')) {
                warnings.push(this.buildWeakTriggerWarning(result, volumeRatio, locale));
            } else if (volumeRatio >= 1.5 && noBreakout) {
                warnings.push('Trigger candle приемлемая, объём высокий, но 4H структура остаётся в RANGE и пробой не подтверждён.');
            } else if (volumeRatio >= 1.5) {
                warnings.push('Trigger candle поддерживает направление, объём высокий; для входа всё ещё нужен приемлемый R/R.');
            } else if (volumeRatio >= 1.2) {
                warnings.push(`${triggerIsStrong ? 'Trigger candle сильная' : 'Trigger candle приемлемая'}, но объём ${volumeRatio.toFixed(2)}x не дотягивает до breakout-confirmation > 1.5x, а R/R с текущей цены остаётся слабым.`);
            } else if (triggerIsAcceptable) {
                warnings.push(`Trigger candle приемлемая, но не даёт сильного breakout-подтверждения: ${closeLocationText}, объём ${volumeRatio.toFixed(2)}x, breakout не подтверждён.`);
            } else {
                warnings.push('Trigger candle поддерживает направление, но для входа всё ещё нужны объём и приемлемый R/R.');
            }
        }
        return warnings;
    }

    private buildWeakTriggerWarning(result: AnalysisResult, volumeRatio: number, locale: 'ru' | 'en'): string {
        const closeLocationText = this.describeTriggerCloseLocation(result, locale);
        const bodyPct = this.extractTriggerBodyPct(result);
        const hasGoodBody = bodyPct !== undefined && bodyPct >= 50;
        const lowVolume = volumeRatio > 0 && volumeRatio < 0.8;

        if (locale !== 'ru') {
            if (hasGoodBody && lowVolume) {
                return `Trigger candle: bullish price action, but weak volume (${volumeRatio.toFixed(2)}x). Body ${bodyPct.toFixed(1)}%, ${closeLocationText}; no breakout confirmation.`;
            }
            return `Trigger candle is weak: ${closeLocationText}, volume ${volumeRatio.toFixed(2)}x; no breakout confirmation.`;
        }

        if (hasGoodBody && lowVolume) {
            return `Trigger candle: бычья по форме, слабая по объёму (${volumeRatio.toFixed(2)}x). Тело ${bodyPct.toFixed(1)}%, ${closeLocationText}; breakout-confirmation нет.`;
        }
        return `Trigger candle слабая: ${closeLocationText}, объём ${volumeRatio.toFixed(2)}x; breakout-confirmation нет.`;
    }

    private buildLocalizedScenarios(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.nextConditions;

        if (result.primaryScenario === 'NEUTRAL') {
            return [
                'Long: 4H выходит из RANGE вверх и закрепляется над ключевым уровнем; затем нужен ретест как поддержки, R/R >= 1.8, CVD UP/positive delta, BTC сильный, USDT.D без risk-off.',
                'Short: rejection от верхней границы диапазона/сопротивления или breakdown/retest; R/R >= 1.8, CVD DOWN/negative delta, long-позиционирование остаётся перегретым, USDT.D растёт/risk-off.',
                'Сейчас нет single-side сценария: R/R может быть приемлемым, но directional/setup confirmation недостаточен.'
            ];
        }

        const level = result.riskManagement.nearestBlockingLevel;
        const required = result.riskManagement.requiredEntryForMinRr;
        const support = result.riskManagement.requiredEntryForMinRr;
        const scenarios: string[] = [];
        const isLong = result.primaryScenario === 'LONG';
        if (level && isLong) {
            const cvdCondition = result.analysis.orderFlow.includes('CVD UP')
                ? 'CVD продолжает расти'
                : 'CVD разворачивается вверх';
            scenarios.push(`Активация breakout LONG: закрытие 4H выше ${level} + объём > 1.5x + ${cvdCondition}. Это ещё не вход.`);
            scenarios.push(`Вход по breakout LONG: ждать ретест ${level} как поддержки; вход только если R/R после ретеста >= 1.8.`);
        } else if (level) {
            scenarios.push(`Breakdown SHORT: вход только после пробоя поддержки, ретеста уровня снизу как сопротивления и нового расчёта R/R >= 1.8.`);
        }
        if (required) {
            scenarios.push(isLong
                ? `Pullback LONG: предпочтительная зона около ${support} или ниже, но вход только после bullish reaction на 1H/4H и сохранения R/R >= 1.8. ${this.getReferenceZoneValidityText(result, locale)}`
                : `Pullback SHORT: предпочтительная зона около ${support} или выше, но вход только после rejection на 1H/4H и сохранения R/R >= 1.8. ${this.getReferenceZoneValidityText(result, locale)}`);
        }
        return scenarios;
    }

    private getReferenceZoneValidityText(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const hasConfirmedRetest = result.analysis.retestStatus.toLowerCase().includes('confirmed');
        if (locale !== 'ru') {
            return hasConfirmedRetest
                ? 'The missed reference zone is valid again only if new local structure forms.'
                : 'This reference zone is only a guide and needs new local confirmation.';
        }
        return hasConfirmedRetest
            ? 'Пропущенная reference-зона снова может стать рабочей только при новой локальной SL/TP-структуре и R/R >= 1.8.'
            : 'Эта reference-зона остаётся только ориентиром и требует нового подтверждения.';
    }

    private buildLocalizedWhyNotNow(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.whyNotNow;

        const reasons: string[] = [];
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        if (result.primaryScenario === 'NEUTRAL') {
            const rrNumber = result.riskManagement.riskReward || 0;
            reasons.push(rrNumber >= 1.8
                ? `R/R формально достаточный (${rr}), но directional/setup confirmation недостаточен.`
                : `R/R сейчас ${rr}, минимум для сделки 1.8.`);
            reasons.push(`Directional edge слабый: 1W ${result.marketState.weeklyTrend}, 1D ${result.marketState.dailyTrend}, 4H ${result.marketState.h4Trend}, 1H ${result.marketState.h1Trend}.`);
            const volumeRatio = this.extractVolumeRatio(result);
            if (volumeRatio >= 1.5) {
                reasons.push(`Объём высокий (${volumeRatio.toFixed(2)}x), но структура пробоя не подтверждена.`);
            } else if (volumeRatio > 0) {
                reasons.push(`Объём ${volumeRatio.toFixed(2)}x от среднего не даёт самостоятельного подтверждения.`);
            }
            if (this.hasCrowdedLongRisk(result)) {
                reasons.push('Funding/positioning указывают на риск long-crowding, но это warning, а не самостоятельный short-сигнал.');
            }
            return reasons;
        }

        if ((result.riskManagement.riskReward || 0) < 1.8) {
            reasons.push(`R/R сейчас ${rr}, минимум для сделки 1.8.`);
        }

        if (result.primaryScenario === 'LONG' && (result.marketState.weeklyTrend === 'DOWNTREND' || result.marketState.dailyTrend === 'DOWNTREND')) {
            if (result.marketState.weeklyTrend === 'DOWNTREND' && result.marketState.dailyTrend === 'DOWNTREND') {
                reasons.push('1W и 1D остаются в DOWNTREND, поэтому long против HTF требует более качественного входа.');
            } else if (result.marketState.weeklyTrend === 'DOWNTREND') {
                reasons.push('HTF-контекст смешанный: 1W DOWNTREND, но 1D уже UPTREND. Поэтому long допустим только с хорошим R/R и подтверждением.');
            } else {
                reasons.push('HTF-контекст смешанный: 1W не bearish, но 1D DOWNTREND. Поэтому long требует более качественного входа.');
            }
        }
        if (result.primaryScenario === 'SHORT' && (result.marketState.weeklyTrend === 'UPTREND' || result.marketState.dailyTrend === 'UPTREND')) {
            if (result.marketState.weeklyTrend === 'UPTREND' && result.marketState.dailyTrend === 'UPTREND') {
                reasons.push('1W и 1D остаются в UPTREND, поэтому short против HTF требует более качественного входа.');
            } else if (result.marketState.weeklyTrend === 'UPTREND') {
                reasons.push('HTF-контекст смешанный: 1W UPTREND, но 1D уже слабее. Поэтому short допустим только с хорошим R/R и подтверждением.');
            } else {
                reasons.push('HTF-контекст смешанный: 1W не bullish, но 1D UPTREND. Поэтому short требует более качественного входа.');
            }
        }
        if (result.marketRegimeDetails.rangePosition === 'HIGH' || result.setupReason.includes('premium')) {
            reasons.push('Цена находится в premium/верхней части диапазона.');
        }
        if (result.riskManagement.nearestBlockingLevel) {
            const levelText = result.riskSide === 'SHORT' ? 'Ближайшая поддержка' : 'Ближайшее сопротивление';
            reasons.push(`${levelText} ${result.riskManagement.nearestBlockingLevel} блокирует чистый путь к TP.`);
        }
        if (result.riskManagement.missedRetestEntry) {
            reasons.push(this.retestLevelInsideEntryZone(result)
                ? 'Ретест reference-зоны уже был, но текущий вход пропущен.'
                : 'Локальная реакция уже была, но ретест текущей reference-зоны не подтверждён.');
        }
        const ratio = this.extractVolumeRatio(result);
        if (ratio > 0) {
            reasons.push(ratio >= 1.5
                ? `Объём высокий (${ratio.toFixed(2)}x), но структура пробоя не подтверждена.`
                : ratio >= 1.2
                    ? `Объём ${ratio.toFixed(2)}x нормальный, но не дотягивает до breakout-confirmation > 1.5x.`
                    : ratio >= 0.9
                        ? `Объём ${ratio.toFixed(2)}x от среднего — нормальный, но недостаточный для breakout-confirmation > 1.5x.`
                        : `Объём слабый (${ratio.toFixed(2)}x от среднего), нет подтверждения пробоя.`);
        }
        if (result.primaryScenario === 'LONG' && this.hasCrowdedLongRisk(result)) {
            reasons.push('Funding/positioning выглядят crowded и повышают риск резкого сброса, если цена не закрепится выше сопротивления.');
        }

        return reasons;
    }

    private extractVolumeRatio(result: AnalysisResult): number {
        const volumeMatch = result.analysis.volume.match(/([0-9.]+)x average/);
        return volumeMatch ? Number(volumeMatch[1]) : 0;
    }

    private extractTriggerCloseLocation(result: AnalysisResult): number | undefined {
        const match = result.analysis.triggerCandle.match(/close location ([0-9.]+)%/i);
        return match ? Number(match[1]) : undefined;
    }

    private extractTriggerBodyPct(result: AnalysisResult): number | undefined {
        const match = result.analysis.triggerCandle.match(/body ([0-9.]+)%/i);
        return match ? Number(match[1]) : undefined;
    }

    private describeTriggerCloseLocation(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const closeLocation = this.extractTriggerCloseLocation(result);
        if (closeLocation === undefined || Number.isNaN(closeLocation)) {
            return locale === 'ru'
                ? 'закрытие в диапазоне не определено'
                : 'close location is unavailable';
        }

        if (locale !== 'ru') {
            if (closeLocation >= 70) return `close is in the upper part of the candle range (${closeLocation.toFixed(1)}%)`;
            if (closeLocation <= 30) return `close is in the lower part of the candle range (${closeLocation.toFixed(1)}%)`;
            return `close is near the middle of the candle range (${closeLocation.toFixed(1)}%)`;
        }

        if (closeLocation >= 70) return `закрытие в верхней части диапазона свечи (${closeLocation.toFixed(1)}%)`;
        if (closeLocation <= 30) return `закрытие в нижней части диапазона свечи (${closeLocation.toFixed(1)}%)`;
        return `закрытие около середины диапазона свечи (${closeLocation.toFixed(1)}%)`;
    }

    private hasCrowdedLongRisk(result: AnalysisResult): boolean {
        return result.analysis.derivatives.includes('overlong') ||
            result.analysis.derivatives.includes('long-biased') ||
            /30d rank (9\d|100)\/100/.test(result.analysis.derivatives);
    }

    private buildLocalizedRequiredEntry(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (locale !== 'ru') return result.analysis.requiredEntry;
        const required = result.riskManagement.requiredEntryForMinRr;
        const level = result.riskManagement.nearestBlockingLevel;
        if (result.primaryScenario === 'NEUTRAL') {
            if (required) {
                const sideText = result.riskSide === 'LONG'
                    ? `Для текущей long-геометрии вход должен быть не выше ${required}.`
                    : `Для текущей short-геометрии вход должен быть не ниже ${required}.`;
                return `${sideText} Но при NEUTRAL bias это не торговая рекомендация: сначала нужен directional edge и подтверждение структуры.`;
            }
            return 'При NEUTRAL bias сначала нужен directional edge; R/R-геометрия сама по себе не активирует сделку.';
        }
        if (required && level) {
            if (result.primaryScenario === 'LONG') {
                return `Для R/R >= 1.8 long-вход: <= ${required}; либо breakout выше ${level} + retest. Reference-зона не сигнал: вход выше ${required} требует новой SL/TP-структуры.`;
            }
            return `Для R/R >= 1.8 pullback short-вход должен быть около ${required} или выше. Breakdown short — отдельный сценарий: нужен пробой поддержки, ретест снизу и новый расчёт R/R.`;
        }
        if (required) {
            return result.primaryScenario === 'LONG'
                ? `Для R/R >= 1.8 long-вход должен быть не выше ${required}.`
                : `Для R/R >= 1.8 short-вход должен быть не ниже ${required}.`;
        }
        return 'Нужен откат или новый пробой/ретест, чтобы R/R стал >= 1.8.';
    }

    // --- CHANNEL BROADCAST METHODS (NEW) ---
    // Эти методы вызываются из ReportingService по расписанию

    public async broadcastLiquidationDigest(hours: number): Promise<void> {
        if (!TELEGRAM_CHANNEL_ID) return;

        try {
            const now = new Date();
            const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
            const summary = await this.dbService.getLiquidationSummary(start, now, 10);
            if (summary.length === 0) return;

            const totalLongs = summary.reduce((sum, item) => sum + item.longs, 0);
            const totalShorts = summary.reduce((sum, item) => sum + item.shorts, 0);

            let message = `📌 *Liquidation Digest (${hours}h)*\n\n`;
            message += `🔴 Longs: *${this.formatCompactMoney(totalLongs)}*\n`;
            message += `🟢 Shorts: *${this.formatCompactMoney(totalShorts)}*\n\n`;
            message += `*Top pairs:*\n`;

            summary.forEach((item: LiquidationSummary, index: number) => {
                const total = item.longs + item.shorts;
                const dominant = item.longs >= item.shorts ? 'Longs' : 'Shorts';
                message += `${index + 1}. *${item.symbol}* ${this.formatCompactMoney(total)} (${dominant}, ${item.orders} orders)\n`;
            });

            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        } catch (error) {
            console.error(`Error broadcasting ${hours}h liquidation digest:`, error);
        }
    }

    public async broadcastTopFunding(): Promise<void> {
        if (!TELEGRAM_CHANNEL_ID) return;

        try {
            const { high, low } = await this.marketDataService.getTopFundingRates(5);
            const formatRate = (d: any) => `*${d.symbol}* (${d.exchange}): ${(d.rate * 100).toFixed(4)}%`;

            let message = `⚡ *Funding Rate Update* (Top 5)\n\n`;
            
            message += `🔥 *Potential Long Squeeze (High +):*\n`; 
            high.forEach((d, i) => message += `${i+1}. ${formatRate(d)}\n`);
            
            message += `\n🧊 *Potential Short Squeeze (Deep -):*\n`;
            low.forEach((d, i) => message += `${i+1}. ${formatRate(d)}\n`);

            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        } catch (error) {
            console.error('Error broadcasting funding:', error);
        }
    }

    public async broadcastDailyStats(): Promise<void> {
        if (!TELEGRAM_CHANNEL_ID) return;

        const now = new Date();
        const prev = new Date(now.getTime() - 24*60*60*1000);
        const liqs = await this.dbService.getOverallLiquidationsBetween(prev, now);
        
        if(!liqs.length) return;
        
        let longs = 0, shorts = 0;
        liqs.forEach(l => l.side === 'long liquidation' ? longs += l.price * l.quantity : shorts += l.price * l.quantity);
        
        const fmt = (v: number) => `$${(v/1000000).toFixed(2)}M`;
        let dominance = '';
        if (longs > shorts) dominance = '🔴 Bears Winning (Longs Rekt)';
        else if (shorts > longs) dominance = '🟢 Bulls Winning (Shorts Squeezed)';
        else dominance = '⚖️ Market Balanced';

        const msg = `📊 *Daily Market Recap* (24h)\n\n` + 
                    `🔴 Longs Rekt: *${fmt(longs)}*\n` +
                    `🟢 Shorts Rekt: *${fmt(shorts)}*\n\n` +
                    `_${dominance}_`;

        await this.sendMessage(TELEGRAM_CHANNEL_ID, msg);
    }

    // --- ALERT: OI SURGE (SMART ANALYTICS) ---
    public async sendOISurgeAlert(surge: OISurge): Promise<void> {
        const isPositive = surge.percentChange > 0;
        const priceUp = surge.priceChangePercent > 0;

        // Логика определения сентимента
        let sentiment = '';
        let sentimentIcon = '';
        
        if (isPositive && priceUp) {
            sentiment = 'Longs Entering (Strong Bullish)';
            sentimentIcon = '🟢🐂';
        } else if (isPositive && !priceUp) {
            sentiment = 'Shorts Entering (Strong Bearish)';
            sentimentIcon = '🔴🐻';
        } else if (!isPositive && !priceUp) {
            sentiment = 'Longs Closing (Reversal Risk)';
            sentimentIcon = '⚠️📉';
        } else if (!isPositive && priceUp) {
            sentiment = 'Shorts Covering (Squeeze)';
            sentimentIcon = '⚠️📈';
        }

        const emoji = isPositive ? '📈' : '📉';
        const action = isPositive ? 'SURGED' : 'DROPPED';
        const color = isPositive ? '🟢' : '🔴';

        const message = `${emoji} *OI ALERT: ${surge.symbol}*\n\n` +
                        `${color} OI ${action} by *${surge.percentChange.toFixed(2)}%* (1h)\n` +
                        `📊 Price Change: *${surge.priceChangePercent > 0 ? '+' : ''}${surge.priceChangePercent.toFixed(2)}%*\n\n` +
                        `🧠 Analysis: *${sentiment}* ${sentimentIcon}\n\n` +
                        `💵 Price: $${surge.price}\n` +
                        `💰 New OI: *$${(surge.currentOI / 1000000).toFixed(2)}M*`;

        // 1. ОТПРАВКА В КАНАЛ
        if (TELEGRAM_CHANNEL_ID) {
            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ОТПРАВКА ЮЗЕРАМ
        const users = await this.dbService.findUsersTrackingSymbol(surge.symbol);
        for (const user of users) {
            if (user.notificationsEnabled) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    // --- ALERT: AGGREGATED REALTIME LIQUIDATIONS ---
    public async sendAggregatedLiquidationAlert(alert: AggregatedLiquidationAlert): Promise<void> {
        const isLong = alert.side === 'long';
        const emoji = isLong ? '🔴' : '🟢';
        const typeText = isLong ? 'Longs liquidated' : 'Shorts liquidated';
        const priceChange = ((alert.lastPrice - alert.firstPrice) / alert.firstPrice) * 100;
        const priceChangeText = `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`;
        const rangeText = `${alert.minPrice.toLocaleString('en-US')} - ${alert.maxPrice.toLocaleString('en-US')}`;

        let context = '';
        try {
            const stats = await this.marketDataService.getAssetStats(alert.symbol);
            if (stats) {
                context =
                    `\n⚡ Funding: *${(stats.fundingRate * 100).toFixed(4)}%*` +
                    `\n📊 OI: *${this.formatCompactMoney(stats.openInterest)}*` +
                    `\n⚖️ Positioning: *${this.formatPositioning(stats.longShortRatio)}*`;
            }
        } catch (error) {
            console.error(`[${alert.symbol}] Failed to fetch liquidation context:`, error);
        }

        const message = `${emoji} *${alert.symbol} ${typeText}*\n\n` +
                        `💰 Volume: *${this.formatCompactMoney(alert.totalVolume)}* in ${alert.windowSeconds}s\n` +
                        `🧾 Orders: *${alert.count}*\n` +
                        `📉 Price move: *${priceChangeText}* (${rangeText})` +
                        `${context}`;

        if (TELEGRAM_CHANNEL_ID && alert.totalVolume >= CHANNEL_MIN_LIQUIDATION) {
             await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        const users = await this.dbService.findUsersTrackingSymbol(alert.symbol);
        for (const user of users) {
            if (user.notificationsEnabled && alert.totalVolume >= user.minLiquidationAlert) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    // --- ALERT: CASCADE LIQUIDATIONS ---
    public async sendCascadeAlert(symbol: string, buffer: CascadeBuffer): Promise<void> {
        const isLong = buffer.side === 'long';
        const emoji = isLong ? '🌊🩸' : '🚀💸';
        const typeText = isLong ? 'Longs Rekt' : 'Shorts Squeezed';
        
        const priceDiff = Math.abs(buffer.maxPrice - buffer.minPrice);
        const priceChange = (priceDiff / buffer.minPrice * 100).toFixed(2);
        
        const formattedVol = buffer.totalVolume >= 1000000 
            ? `$${(buffer.totalVolume / 1000000).toFixed(2)}M` 
            : `$${(buffer.totalVolume / 1000).toFixed(0)}K`;

        // Получаем OI для контекста
        let extraInfo = '';
        try {
            const stats = await this.marketDataService.getAssetStats(symbol);
            if (stats) {
                extraInfo += `\n📊 OI: $${(stats.openInterest / 1000000).toFixed(1)}M`;
            }
        } catch (e) {
            // Игнорируем ошибки API
        }

        const message = `${emoji} *CASCADE ALERT: ${symbol}*\n\n` +
                        `💀 *${typeText}* (x${buffer.count} orders)\n` +
                        `💰 Total Volume: *${formattedVol}* in 10s\n` +
                        `📉 Range: ${buffer.minPrice} - ${buffer.maxPrice} (${priceChange}%)\n` +
                        `${extraInfo}`;

        // 1. ОТПРАВКА В КАНАЛ
        if (TELEGRAM_CHANNEL_ID && buffer.totalVolume >= CHANNEL_MIN_LIQUIDATION) {
            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ОТПРАВКА ЮЗЕРАМ
        const users = await this.dbService.findUsersTrackingSymbol(symbol);
        for (const user of users) {
            if (user.notificationsEnabled && buffer.totalVolume >= user.minLiquidationAlert) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    // --- ALERT: 15M LIQUIDATION DISBALANCE ---
    public async sendDisbalanceAlert(alert: DisbalanceAlert): Promise<void> {
        const longsDominant = alert.longs >= alert.shorts;
        const dominantText = longsDominant ? 'Long liquidations dominate' : 'Short liquidations dominate';
        const emoji = longsDominant ? '🔴⚠️' : '🟢⚠️';

        const message = `${emoji} *LIQUIDATION DISBALANCE: ${alert.symbol}*\n\n` +
                        `${dominantText} over ${alert.windowMinutes}m\n` +
                        `🔴 Longs: *${this.formatCompactMoney(alert.longs)}*\n` +
                        `🟢 Shorts: *${this.formatCompactMoney(alert.shorts)}*\n` +
                        `📐 Ratio: *${alert.ratio.toFixed(1)}x*`;

        if (TELEGRAM_CHANNEL_ID) {
            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        const users = await this.dbService.findUsersTrackingSymbol(alert.symbol);
        for (const user of users) {
            if (user.notificationsEnabled) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    // --- ALERT: REALTIME LIQUIDATION ---
    public async sendRealtimeLiquidationAlert(liquidation: LiquidationData): Promise<void> {
        const value = liquidation.price * liquidation.quantity;
        const isLarge = value >= 500000;
        const isWhale = value >= 1000000;

        let icon = liquidation.side === 'long liquidation' ? '🔴' : '🟢';
        if (isLarge) icon = liquidation.side === 'long liquidation' ? '🚨💀🔴' : '🚀💰🟢';

        const rektType = liquidation.side === 'long liquidation' ? 'Long' : 'Short';
        const formattedValue = value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : `${(value / 1000).toFixed(0)}K`;

        let message = `${icon} *#${liquidation.symbol} REKT ${rektType}:* $${formattedValue} at $${liquidation.price.toLocaleString('en-US')}`;
        if (isWhale) message = `🔥 *WHALE ALERT!* 🔥\n${message}`;

        // 1. КАНАЛ
        if (TELEGRAM_CHANNEL_ID && value >= CHANNEL_MIN_LIQUIDATION) {
             await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ЮЗЕРЫ
        const users = await this.dbService.findUsersTrackingSymbol(liquidation.symbol);
        if (users.length === 0) return;

        for (const user of users) {
            if (user.notificationsEnabled && value >= user.minLiquidationAlert) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    // --- BUTTON HANDLER: OI MENU ---
    private async handleOIMenu(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId, 
            `📊 *Open Interest Checker*\n\n` +
            `To check the aggregated Open Interest and Funding Rate across Binance, Bybit, MEXC, and Bitget, use the command:\n\n` +
            `\`/oi <SYMBOL>\`\n\n` +
            `Example: \`/oi BTC\`, \`/oi DOGE\``, 
            { parse_mode: 'Markdown' }
        );
    }

    // --- COMMAND: /oi BTC ---
    private async handleOpenInterest(msg: Message, match: RegExpExecArray | null): Promise<void> {
        if (!match || !match[1]) return;
        const symbolInput = match[1].trim();
        const chatId = msg.chat.id;

        await this.bot.sendMessage(chatId, `🔍 Scanning exchanges for *${symbolInput.toUpperCase()}*...`, { parse_mode: 'Markdown' });

        const stats = await this.marketDataService.getAggregatedStats(symbolInput);

        if (!stats) {
            await this.bot.sendMessage(chatId, `❌ No data found for ${symbolInput}. Try adding 'USDT' if needed.`);
            return;
        }

        const formatMoney = (val: number) => {
            if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
            if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
            return `$${(val / 1_000).toFixed(0)}K`;
        };

        const mainExchange = stats.exchanges[0];
        const timeLeftMs = mainExchange.nextFundingTime - Date.now();
        const hours = Math.floor(timeLeftMs / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
        const timeStr = timeLeftMs > 0 ? `${hours}h ${minutes}m` : 'Now';

        let msgText = `📊 *${stats.symbol}USDT Aggregated Stats*\n\n`;
        
        msgText += `💰 *Total OI:* ${formatMoney(stats.totalOpenInterest)}\n`;
        msgText += `💵 *Avg Price:* $${stats.avgPrice.toFixed(4)}\n`;
        msgText += `⏳ *Next Funding:* ${timeStr}\n\n`;

        msgText += `*By Exchange (OI | Funding):*\n`;
        
        for (const ex of stats.exchanges) {
            const fundingPercent = (ex.fundingRate * 100).toFixed(4);
            let icon = '▪️';
            if (ex.fundingRate > 0.0001) icon = '🔥'; 
            if (ex.fundingRate < 0) icon = '🧊';      

            msgText += `${ex.name}\n`;
            msgText += `   ├ OI: *${formatMoney(ex.openInterest)}*\n`;
            msgText += `   └ Fund: *${fundingPercent}%* ${icon}\n`;
        }
        
        msgText += `\n_High positive = Longs pay Shorts_\n_Negative = Shorts pay Longs_`;

        await this.bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }

    // --- COMMAND: /ratio BTCUSDT ---
    private async handleRatio(msg: Message, match: RegExpExecArray | null): Promise<void> {
        if (!match || !match[1]) return;
        const symbol = match[1].trim();
        const chatId = msg.chat.id;

        const stats = await this.marketDataService.getAssetStats(symbol);
        if (!stats) {
            await this.bot.sendMessage(chatId, `❌ Could not fetch ratio for ${symbol}. This metric is Binance-only.`);
            return;
        }

        const positioning = this.formatPositioning(stats.longShortRatio);

        const msgText = `⚖️ *${stats.symbol} Top Trader Positioning*\n\n` +
                        `Positioning: *${positioning}*\n\n` +
                        `_Above 1.0 means more long accounts; below 1.0 means more short accounts._`;

        await this.bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    }

    // --- COMMAND: TOP FUNDING ---
    private async handleTopFunding(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId, '🔍 Fetching global funding rates...');

        try {
            const { high, low } = await this.marketDataService.getTopFundingRates(10);

            const formatRate = (d: any) => `*${d.symbol}* (${d.exchange}): ${(d.rate * 100).toFixed(4)}%`;

            let message = `⚡ *GLOBAL TOP Funding Rates*\n\n`;
            message += `🔥 *Highest (Potential Long Squeeze):*\n`; 
            high.forEach((d, i) => message += `${i+1}. ${formatRate(d)}\n`);
            
            message += `\n🧊 *Lowest (Potential Short Squeeze):*\n`;
            low.forEach((d, i) => message += `${i+1}. ${formatRate(d)}\n`);

            message += `\n_High positive = Longs pay Shorts_\n_Negative = Shorts pay Longs_`;

            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error handling top funding:', error);
            await this.bot.sendMessage(chatId, 'Failed to fetch funding data.');
        }
    }

    // --- STANDARD HANDLERS ---

    private async handleAnalyze(msg: Message, match: RegExpExecArray | null): Promise<void> {
        const chatId = msg.chat.id;
        const symbol = match?.[1]?.trim();
        if (!symbol) {
            await this.bot.sendMessage(chatId, 'Usage: /analyze SOLUSDT');
            return;
        }

        await this.bot.sendMessage(chatId, `🔎 Analyzing *${symbol.toUpperCase()}* on 4H...`, { parse_mode: 'Markdown' });

        try {
            const user = await this.dbService.getUser(chatId);
            const locale = user?.locale || 'ru';
            const result = await this.analysisService.analyze(symbol, locale);
            await this.sendMessage(chatId, this.formatAnalysisResult(result, locale), { parse_mode: 'HTML' });
            await this.sendMessage(chatId, this.formatAnalysisSummary(result, locale), { parse_mode: 'HTML' });
        } catch (error: any) {
            console.error(`Failed to analyze ${symbol}:`, error);
            await this.bot.sendMessage(chatId, `Analysis failed: ${error.message || 'unknown error'}`);
        }
    }

    private async handleStatus(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        if (!TELEGRAM_ADMIN_IDS.includes(chatId)) {
            await this.bot.sendMessage(chatId, TELEGRAM_ADMIN_IDS.length === 0
                ? 'Admin access is not configured. Set TELEGRAM_ADMIN_IDS in .env.'
                : 'Access denied.');
            return;
        }

        if (!this.statusProvider) {
            await this.bot.sendMessage(chatId, 'Status provider is not initialized.');
            return;
        }

        const status = await this.statusProvider();
        const users = status.db.users;
        const lastItems = status.db.lastLiquidations
            .slice(0, 5)
            .map(liq => {
                const value = liq.price * liq.quantity;
                return `• ${liq.symbol} ${liq.side.replace(' liquidation', '')}: ${this.formatCompactMoney(value)} at ${new Date(liq.time).toLocaleTimeString('en-US', { hour12: false })}`;
            })
            .join('\n') || 'none';

        const socketStates = Object.entries(status.listener.socketStates)
            .map(([state, count]) => `${state}: ${count}`)
            .join(', ') || 'none';

        const text = `🛠 *System Status*\n\n` +
                     `Uptime: *${this.formatUptime(status.uptimeSeconds)}*\n` +
                     `WS: *${status.listener.activeSockets}* sockets (${socketStates})\n` +
                     `Tracked pairs: *${status.listener.trackedSymbols}*\n` +
                     `Messages: *${status.listener.messagesReceived}*, liquidations: *${status.listener.liquidationsProcessed}*\n` +
                     `Aggregates sent: *${status.listener.aggregatesSent}*, cascades: *${status.listener.cascadesSent}*, disbalances: *${status.listener.disbalanceAlertsSent}*\n` +
                     `Pending: *${status.listener.pendingAggregates}* agg / *${status.listener.pendingCascades}* cascades\n` +
                     `Last liquidation: *${status.listener.lastLiquidationAt || 'none'}*\n\n` +
                     `Users: *${users.totalUsers}* total / *${users.activeUsers}* active\n` +
                     `User thresholds: min ${this.formatCompactMoney(users.minThreshold)}, avg ${this.formatCompactMoney(users.avgThreshold)}, max ${this.formatCompactMoney(users.maxThreshold)}\n` +
                     `Channel threshold: *${this.formatCompactMoney(status.thresholds.channelMinLiquidation)}*\n\n` +
                     `*Last saved liquidations:*\n${lastItems}`;

        await this.sendMessage(chatId, text);
    }

    private async handleStart(msg: Message): Promise<void> {
        const { id: chatId, first_name: firstName, username } = msg.chat;
        await this.dbService.findOrCreateUser(chatId, firstName, username);
        const displayName = firstName || 'there';
        const welcomeMessage = `👋 Hello, ${displayName}!\n\nI am your advanced crypto liquidations tracker.\n\n` +
                               `I track liquidations, funding rates, and open interest.\n\n` +
                               `Use the menu below to control the bot.`;

        this.bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: this.generateMainMenuKeyboard(),
            parse_mode: 'Markdown'
        });
    }

    private async handleReportNow(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);

        if (!user) {
            await this.bot.sendMessage(chatId, 'Please run /start first.');
            return;
        }

        await this.bot.sendMessage(chatId, 'Generating your report, please wait...');
        const reportMessage = await this.reportingService.generateReportForUser(user, user.reportIntervalHours);

        if (reportMessage) {
            await this.sendMessage(chatId, reportMessage);
        } else {
            await this.sendMessage(chatId, `No significant liquidations to report for you in the last ${user.reportIntervalHours} hours.`);
        }
    }

    private async handleMarketStats(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.bot.sendMessage(chatId, 'Calculating market stats, please wait...');

        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        const liquidations = await this.dbService.getOverallLiquidationsBetween(twentyFourHoursAgo, now);

        if (liquidations.length === 0) {
            await this.bot.sendMessage(chatId, 'No liquidations were recorded in the last 24 hours.');
            return;
        }

        let totalLongsValue = 0;
        let totalShortsValue = 0;

        for (const liq of liquidations) {
            const value = liq.price * liq.quantity;
            if (liq.side === 'long liquidation') {
                totalLongsValue += value;
            } else {
                totalShortsValue += value;
            }
        }

        const formatValue = (value: number) => `$${(value / 1000000).toFixed(2)}M`;
        let dominanceMessage = '';
        if (totalLongsValue > totalShortsValue) dominanceMessage = '🔴 Longs are getting REKT more.';
        else if (totalShortsValue > totalLongsValue) dominanceMessage = '🟢 Shorts are getting SQUEEZED more.';
        else dominanceMessage = 'The market is balanced.';

        const reportMessage = `*Market Liquidations (24h)* 📊\n\n` +
                              `🔴 Longs: *${formatValue(totalLongsValue)}*\n` +
                              `🟢 Shorts: *${formatValue(totalShortsValue)}*\n\n` +
                              `_${dominanceMessage}_`;

        await this.bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
    }

    private async handleTrackedPairs(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);
        if (!user) {
            this.bot.sendMessage(chatId, 'Please run /start first.');
            return;
        }

        const text = 'Select the pairs you want to track. Tap a coin to add or remove it from your list.';
        const keyboard = this.generatePairsKeyboard(user.trackedSymbols, 0);

        await this.bot.sendMessage(chatId, text, {
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    private async handleSettings(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);
        if (!user) {
            this.bot.sendMessage(chatId, 'Please run /start first.');
            return;
        }
        await this.showMainSettings(chatId, undefined);
    }

    // --- INTERACTIVE MENUS ---

    private async showMainSettings(chatId: number, messageId: number | undefined): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        const muteButtonText = user.notificationsEnabled ? '🔇 Mute Alerts' : '🔊 Unmute Alerts';
        const localeText = user.locale === 'en' ? '🇬🇧 English' : '🇷🇺 Русский';
        const text = `⚙️ *Settings*\n\nCurrent analysis language: *${localeText}*\n\nChoose what you want to configure:`;
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⏰ Report Interval', callback_data: 'menu:interval' }],
                    [{ text: '💰 Alert Threshold', callback_data: 'menu:threshold' }],
                    [{ text: `🌐 Analysis Language: ${localeText}`, callback_data: 'menu:language' }],
                    [{ text: muteButtonText, callback_data: 'menu:mute' }],
                    [{ text: '❌ Close', callback_data: 'menu:close' }]
                ]
            }
        };

        if (messageId) {
            try {
                await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
            } catch (e) { 
                console.error('Failed to edit settings message', e); 
            }
        } else {
            await this.bot.sendMessage(chatId, text, options);
        }
    }

    private async showPairsSettings(chatId: number, messageId: number, page: number): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        const text = 'Select pairs to track:';
        const keyboard = this.generatePairsKeyboard(user.trackedSymbols, page);

        try {
            await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (error: any) {
            // Ignore "message is not modified"
        }
    }

    private async showIntervalSettings(chatId: number, messageId: number): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        const text = `Current report interval: *${user.reportIntervalHours} hours*. Select new:`;
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: { inline_keyboard: this.generateIntervalKeyboard(user.reportIntervalHours) }
        };
        await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    }

    private async showThresholdSettings(chatId: number, messageId: number) {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        this.userStates.set(chatId, 'awaiting_threshold');
        const text = `Current alert threshold: *$${user.minLiquidationAlert.toLocaleString('en-US')}*.\n\n` +
                     `Send a new number (e.g. \`50000\`) to update.`;

        await this.deleteMessage(chatId, messageId);
        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    private async showLanguageSettings(chatId: number, messageId: number): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        const current = user.locale || 'ru';
        const text = `Current analysis language: *${current === 'ru' ? 'Русский' : 'English'}*.\n\nSelect language for /analyze reports:`;
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: `${current === 'ru' ? '✅ ' : ''}🇷🇺 Русский`, callback_data: 'set_locale:ru' },
                { text: `${current === 'en' ? '✅ ' : ''}🇬🇧 English`, callback_data: 'set_locale:en' }
            ],
            [{ text: '⬅️ Back to Settings', callback_data: 'menu:settings_main' }]
        ];

        await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    private async handleMessage(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        // Ignore commands
        if (msg.text && (['/start', '📢 Report Now', '📊 Market Stats', '⚡ TOP Funding', '💸 Tracked Pairs', '⚙️ Settings', '📊 Open Interest'].includes(msg.text) || msg.text.startsWith('/'))) return;

        if (this.userStates.get(chatId) === 'awaiting_threshold') {
            const val = parseInt(msg.text || '');
            if (!isNaN(val) && val >= 0) {
                await this.dbService.updateUserAlertThreshold(chatId, val);
                this.userStates.delete(chatId);
                await this.bot.sendMessage(chatId, `✅ Threshold updated to *$${val.toLocaleString('en-US')}*.`, { parse_mode: 'Markdown' });
            } else {
                await this.bot.sendMessage(chatId, "Invalid number. Try again.");
            }
        }
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.message || !query.data) return;

        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const [action, payload, pageStr] = query.data.split(':');
        const page = parseInt(pageStr || '0', 10);

        if (action === 'menu') {
            if (payload === 'pairs') await this.showPairsSettings(chatId, messageId, page);
            else if (payload === 'interval') await this.showIntervalSettings(chatId, messageId);
            else if (payload === 'threshold') await this.showThresholdSettings(chatId, messageId);
            else if (payload === 'language') await this.showLanguageSettings(chatId, messageId);
            else if (payload === 'settings_main') await this.showMainSettings(chatId, messageId);
            else if (payload === 'close') await this.deleteMessage(chatId, messageId);
            else if (payload === 'mute') {
                const updatedUser = await this.dbService.toggleUserNotifications(chatId);
                if (updatedUser) {
                    await this.showMainSettings(chatId, messageId);
                    this.bot.sendMessage(chatId, updatedUser.notificationsEnabled ? '🔊 Alerts enabled.' : '🔇 Alerts muted.');
                }
            }
        } else if (action === 'toggle_pair') {
            const updatedUser = await this.dbService.toggleSymbolForUser(chatId, payload);
            if (updatedUser) {
                const newKeyboard = this.generatePairsKeyboard(updatedUser.trackedSymbols, page);
                await this.bot.editMessageReplyMarkup({
                    inline_keyboard: newKeyboard
                }, { chat_id: chatId, message_id: messageId });
            }
        } else if (action === 'set_all_pairs') {
            const symbolsToSet = payload === 'select' ? SYMBOLS_TO_TRACK : [];
            const updatedUser = await this.dbService.setAllSymbolsForUser(chatId, symbolsToSet);
            if (updatedUser) {
                const newKeyboard = this.generatePairsKeyboard(updatedUser.trackedSymbols, page);
                await this.bot.editMessageReplyMarkup({
                    inline_keyboard: newKeyboard
                }, { chat_id: chatId, message_id: messageId });
            }
        } else if (action === 'set_interval') {
            await this.dbService.updateUserReportInterval(chatId, parseInt(payload));
            await this.showIntervalSettings(chatId, messageId);
            this.bot.sendMessage(chatId, `Report interval updated to ${payload}h.`);
        } else if (action === 'set_locale') {
            const locale = payload === 'en' ? 'en' : 'ru';
            await this.dbService.updateUserLocale(chatId, locale);
            await this.showLanguageSettings(chatId, messageId);
            this.bot.sendMessage(chatId, locale === 'ru' ? 'Язык анализа: Русский.' : 'Analysis language: English.');
        }

        await this.bot.answerCallbackQuery(query.id);
    }

    // --- KEYBOARD GENERATORS ---

    private generateMainMenuKeyboard(): TelegramBot.ReplyKeyboardMarkup {
        return {
            keyboard: [
                [{ text: '📢 Report Now' }, { text: '📊 Market Stats'}],
                [{ text: '⚡ TOP Funding' }, { text: '📊 Open Interest' }],
                [{ text: '💸 Tracked Pairs' }, { text: '⚙️ Settings' }]
            ],
            resize_keyboard: true,
        };
    }

    private generatePairsKeyboard(userSymbols: string[], page: number): TelegramBot.InlineKeyboardButton[][] {
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        const userSymbolsSet = new Set(userSymbols);

        const totalPages = Math.ceil(SYMBOLS_TO_TRACK.length / PAIRS_PAGE_SIZE);
        const startIndex = page * PAIRS_PAGE_SIZE;
        const endIndex = startIndex + PAIRS_PAGE_SIZE;
        const pageSymbols = SYMBOLS_TO_TRACK.slice(startIndex, endIndex);

        for (let i = 0; i < pageSymbols.length; i += 2) {
            const row: TelegramBot.InlineKeyboardButton[] = [];
            const symbol1 = pageSymbols[i];
            const symbol2 = pageSymbols[i + 1];
            if (symbol1) {
                const text1 = userSymbolsSet.has(symbol1) ? `✅ ${symbol1}` : symbol1;
                row.push({ text: text1, callback_data: `toggle_pair:${symbol1}:${page}` });
            }
            if (symbol2) {
                const text2 = userSymbolsSet.has(symbol2) ? `✅ ${symbol2}` : symbol2;
                row.push({ text: text2, callback_data: `toggle_pair:${symbol2}:${page}` });
            }
            keyboard.push(row);
        }

        const navigationRow: TelegramBot.InlineKeyboardButton[] = [];
        if (totalPages > 1) {
            if (page > 0) navigationRow.push({ text: '◀️ Prev', callback_data: `menu:pairs:${page - 1}` });
            navigationRow.push({ text: `· ${page + 1}/${totalPages} ·`, callback_data: 'noop' });
            if (page < totalPages - 1) navigationRow.push({ text: 'Next ▶️', callback_data: `menu:pairs:${page + 1}` });
            keyboard.push(navigationRow);
        }

        keyboard.push([
            { text: '✅ Select All', callback_data: `set_all_pairs:select:${page}` },
            { text: '❌ Deselect All', callback_data: `set_all_pairs:deselect:${page}` }
        ]);
        keyboard.push([{ text: '❌ Close', callback_data: 'menu:close' }]);

        return keyboard;
    }

    private generateIntervalKeyboard(currentInterval: number): TelegramBot.InlineKeyboardButton[][] {
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        const row: TelegramBot.InlineKeyboardButton[] = [];

        this.reportIntervals.forEach(interval => {
            const text = currentInterval === interval ? `✅ ${interval}h` : `${interval}h`;
            row.push({ text, callback_data: `set_interval:${interval}` });
        });

        keyboard.push(row);
        keyboard.push([{ text: '⬅️ Back to Settings', callback_data: 'menu:settings_main' }]);
        return keyboard;
    }

    // --- STANDARD UTILS ---

    public async sendMessage(chatId: string | number, message: string, options: any = { parse_mode: 'Markdown' }): Promise<void> {
        try {
            if (message.length > 3900) {
                const chunks = this.splitTelegramMessage(message, 3800);
                for (const chunk of chunks) {
                    await this.bot.sendMessage(chatId, chunk, options);
                }
                return;
            }

            await this.bot.sendMessage(chatId, message, options);
        } catch (error: any) {
            if (error.response?.body?.error_code === 403) {
                console.warn(`[${chatId}] Blocked. Deactivating.`);
                if (typeof chatId === 'number') {
                    await this.dbService.toggleUserNotifications(chatId, false);
                }
            } else {
                 console.error(`❌ Failed to send to ${chatId}: ${error.message}`);
            }
        }
    }

    private splitTelegramMessage(message: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let current = '';

        for (const line of message.split('\n')) {
            const next = current ? `${current}\n${line}` : line;
            if (next.length <= maxLength) {
                current = next;
                continue;
            }

            if (current) chunks.push(current);
            current = line;
        }

        if (current) chunks.push(current);
        return chunks;
    }

    private async deleteMessage(chatId: number, messageId: number): Promise<void> {
        try {
            await this.bot.deleteMessage(chatId, messageId);
        } catch (error: any) {
             // Ignore if not found
        }
    }
}
