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
        const entry = result.entry.from && result.entry.to
            ? `${result.entry.from} - ${result.entry.to}`
            : 'No trade zone';
        const takeProfits = result.riskManagement.takeProfit.length
            ? result.riskManagement.takeProfit.join(' / ')
            : 'n/a';
        const tradePlan = result.decision === 'WAIT'
            ? `<b>${t.tradePlan}</b>\n` +
              `${t.entryStatus}: <b>${escape(this.getEntryStatusText(result, locale))}</b>\n` +
              `${t.noActiveSetup} <b>${escape(result.entry.currentPrice)}</b>\n` +
              `${result.riskManagement.missedRetestEntry ? t.missedRetestZone : t.referenceZone}: ${escape(entry)}\n` +
              `${escape(shorten(this.localizeRetestEntryComment(result, locale) || t.noEntryWhileWait, 180))}\n\n`
            : `<b>${t.entry}</b>\n` +
              `${t.zone}: <b>${escape(entry)}</b>\n` +
              `${t.current}: <b>${escape(result.entry.currentPrice)}</b>\n\n` +
              `<b>${t.riskManagement}</b>\n` +
              `${t.stop}: <b>${escape(result.riskManagement.stopLoss || 'n/a')}</b>\n` +
              `TP: <b>${escape(takeProfits)}</b>\n` +
              `R/R: <b>${escape(result.riskManagement.riskReward || 'n/a')}</b>\n` +
              `Invalidation: <i>${escape(result.riskManagement.invalidation || result.riskManagement.reason || 'n/a')}</i>\n\n`;
        const warnings = this.buildLocalizedWarnings(result, locale).slice(0, 3).map(item => `• ${escape(shorten(item, 170))}`).join('\n') || '• No major warnings.';
        const scoreBreakdown = result.categoryScores
            .filter(item => ['HTF_CONTEXT', 'MARKET_STRUCTURE_4H', 'DERIVATIVES', 'CVD_DELTA', 'RISK_REWARD'].includes(item.category))
            .map(item => `${item.category.replace(/_/g, ' ')} ${item.score > 0 ? '+' : ''}${item.score}/${item.max}`)
            .join(' | ');
        const nextConditions = this.buildLocalizedScenarios(result, locale).slice(0, 3).map(item => `• ${escape(shorten(item, 240))}`).join('\n') || '• No specific trigger yet.';
        const whyNotNow = this.buildLocalizedWhyNotNow(result, locale)
            .slice(0, 5)
            .map(item => `• ${escape(shorten(item, 160))}`)
            .join('\n') || `• ${locale === 'ru' ? 'Блокирующих причин не найдено.' : 'No blocking reason detected.'}`;
        const tradeConfidence = result.tradeConfidence === null
            ? t.tradeConfidenceNa
            : `${result.tradeConfidence}%`;
        const waitExplanation = result.decision === 'WAIT'
            ? `\n<b>${t.summary}</b>\n${escape(shorten(this.sanitizeReportText(result.aiSummary || result.mainReason), 650))}\n\n` +
              `<b>${t.currentAction}</b>\n${escape(this.buildLocalizedAction(result, locale))}\n`
            : '';

        return `${decisionIcon} <b>${escape(result.symbol)} 4H Analysis</b>\n\n` +
               `${t.decision}: <b>${escape(result.decision)}</b>\n` +
               `${t.directionalBias}: <b>${escape(result.bias)} ${result.directionScore}/100</b>\n` +
               `${t.setupQuality}: <b>${escape(result.setupQuality)} ${result.setupQualityScore}/100</b>\n` +
               `${t.riskScore}: <b>${escape(result.riskScore)}/100</b>\n` +
               `${t.tradeConfidence}: <b>${escape(tradeConfidence)}</b>\n\n` +
               `${waitExplanation}` +
               `${tradePlan}` +
               `<b>${t.whyNotNow}</b>\n${whyNotNow}\n\n` +
               `<b>${t.requiredEntry}</b>\n${escape(shorten(this.buildLocalizedRequiredEntry(result, locale), 260))}\n\n` +
               `<b>${t.marketState}</b>\n` +
               `${t.regime}: ${escape(clean(result.marketRegime))}\n` +
               `1W: ${escape(result.marketState.weeklyTrend)} | 1D: ${escape(result.marketState.dailyTrend)}\n` +
               `4H: ${escape(clean(result.marketState.h4Trend))} | 1H: ${escape(result.marketState.h1Trend)}\n` +
               `BTC: 1D ${escape(result.marketState.btcDailyTrend)}, 4H ${escape(result.marketState.btcH4Trend)}\n` +
               `${t.scores}: ${escape(scoreBreakdown)}\n\n` +
               `<b>${t.context}</b>\n` +
               `${escape(this.localizeVolume(result.analysis.volume, locale))}\n` +
               `${escape(this.localizeRetestStatus(result, locale))}\n` +
               `${escape(this.localizeTriggerCandle(result.analysis.triggerCandle, locale))}\n` +
               `${escape(result.analysis.orderFlow)}\n` +
               `${escape(shorten(result.analysis.derivatives, 260))}\n\n` +
               `<b>${t.oiWarning}</b>\n${escape(shorten(this.stripOiWarningPrefix(result.analysis.oiWarning), 320))}\n\n` +
               `<b>${t.warnings}</b>\n${warnings}\n\n` +
               `<b>${t.setupScenarios}</b>\n${nextConditions}\n\n` +
               `<i>Rule-based MVP. Not financial advice.</i>`;
    }

    private getAnalysisLabels(locale: 'ru' | 'en') {
        if (locale === 'ru') {
            return {
                decision: 'Решение',
                directionalBias: 'Технический bias',
                setupQuality: 'Качество входа',
                riskScore: 'Risk Score',
                tradeConfidence: 'Уверенность сделки',
                tradeConfidenceNa: 'N/A - нет валидной сделки при WAIT',
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
                regime: 'Режим',
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
            regime: 'Regime',
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
        return text.replace(/^OI Warning:\s*/i, '');
    }

    private buildLocalizedAction(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const isLong = result.bias === 'BULLISH';
        const breakoutLevel = result.riskManagement.nearestBlockingLevel;
        const requiredEntry = result.riskManagement.requiredEntryForMinRr;

        if (locale === 'ru') {
            const pullback = requiredEntry
                ? `Long становится валидным только если цена возвращается в зону, где расчётный R/R >= 1.8. По текущей геометрии это не выше ${requiredEntry}.`
                : 'Long становится валидным только если цена возвращается в зону, где расчётный R/R >= 1.8.';
            const breakout = breakoutLevel
                ? `4H закрывается выше ${breakoutLevel}, затем уровень ретестится как поддержка.`
                : '4H пробивает ключевой уровень, затем уровень ретестится.';
            return `Сделки нет.\n\n${isLong ? 'Long' : 'Short'} валиден только если:\n• ${pullback}\n• Или ${breakout}\n• CVD продолжает расти, delta остаётся положительной, bearish divergence не появляется.\n• USDT.D не пробивает диапазон вверх и не показывает risk-off ускорение.`;
        }

        const pullback = requiredEntry
            ? `Pullback gives R/R >= 1.8 around ${requiredEntry}.`
            : 'Pullback gives R/R >= 1.8.';
        const breakout = breakoutLevel
            ? `4H closes above ${breakoutLevel}, then retests it as support.`
            : '4H breaks the key level, then retests it.';
        return `No trade.\n\nValid ${isLong ? 'Long' : 'Short'} Only If:\n• ${pullback}\n• Or ${breakout}\n• CVD keeps confirming.\n• USDT.D does not move against the scenario.`;
    }

    private getEntryStatusText(result: AnalysisResult, locale: 'ru' | 'en'): string {
        const status = result.riskManagement.currentEntryStatus || 'NO_TRADE';
        if (locale === 'ru') {
            if (status === 'MISSED_RETEST') return 'ПРОПУЩЕН';
            if (status === 'TOO_LATE') return 'ПОЗДНИЙ';
            if (status === 'VALID') return 'ВАЛИДЕН';
            if (status === 'WAITING_RETEST') return 'ОЖИДАЕТ РЕТЕСТ';
            return 'НЕТ СДЕЛКИ';
        }
        return status.replace(/_/g, ' ');
    }

    private localizeRetestEntryComment(result: AnalysisResult, locale: 'ru' | 'en'): string | undefined {
        if (!result.riskManagement.retestEntryComment) return undefined;
        if (locale !== 'ru') return result.riskManagement.retestEntryComment;
        const level = result.riskManagement.retestLevel;
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        return `Ретест был подтверждён около ${level || 'уровня'}, но цена ушла выше зоны ретеста, а R/R ухудшился до ${rr}.`;
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
            return `Статус ретеста: подтверждён, но вход пропущен. Цена ушла выше зоны ретеста около ${level}.`;
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

    private buildLocalizedWarnings(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.warnings;

        const warnings: string[] = [];
        if (result.riskManagement.nearestBlockingLevel) {
            warnings.push(`Ближайшее сопротивление ${result.riskManagement.nearestBlockingLevel} ограничивает потенциальный TP-path; при WAIT активный TP не выставляется.`);
        }
        if (result.setupReason.includes('premium')) {
            warnings.push('Long находится в premium-зоне, риск догонять цену повышен.');
        }
        warnings.push('Trigger candle поддерживает направление, но для входа всё ещё нужны объём и приемлемый R/R.');
        return warnings;
    }

    private buildLocalizedScenarios(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.nextConditions;

        const level = result.riskManagement.nearestBlockingLevel;
        const required = result.riskManagement.requiredEntryForMinRr;
        const support = result.riskManagement.requiredEntryForMinRr;
        const scenarios: string[] = [];
        if (level) {
            scenarios.push(`Breakout LONG activation: 4H close выше ${level} + объём > 1.5x + CVD продолжает расти. Это ещё не вход.`);
            scenarios.push(`Breakout LONG entry: ждать ретест ${level} как поддержки; вход только если R/R после ретеста >= 1.8.`);
        }
        if (required) {
            scenarios.push(`Pullback LONG: preferred zone около ${support}, где текущая stop/target-геометрия может дать R/R >= 1.8. Старая retest/reference zone валидна снова только при новой локальной структуре.`);
        }
        return scenarios;
    }

    private buildLocalizedWhyNotNow(result: AnalysisResult, locale: 'ru' | 'en'): string[] {
        if (locale !== 'ru') return result.whyNotNow;

        const reasons: string[] = [];
        const rr = result.riskManagement.riskReward?.toFixed(2) || 'n/a';
        reasons.push(`R/R сейчас ${rr}, минимум для сделки 1.8.`);

        if (result.marketRegimeDetails.rangePosition === 'HIGH' || result.setupReason.includes('premium')) {
            reasons.push('Цена находится в premium/верхней части диапазона.');
        }
        if (result.riskManagement.nearestBlockingLevel) {
            reasons.push(`Ближайшее сопротивление ${result.riskManagement.nearestBlockingLevel} блокирует чистый путь к TP.`);
        }
        if (result.riskManagement.missedRetestEntry) {
            reasons.push('Ретест был подтверждён, но текущий вход уже пропущен.');
        }
        const volumeMatch = result.analysis.volume.match(/([0-9.]+)x average/);
        if (volumeMatch) {
            reasons.push(`Объём только ${volumeMatch[1]}x от среднего, нет сильного подтверждения пробоя.`);
        }

        return reasons;
    }

    private buildLocalizedRequiredEntry(result: AnalysisResult, locale: 'ru' | 'en'): string {
        if (locale !== 'ru') return result.analysis.requiredEntry;
        const required = result.riskManagement.requiredEntryForMinRr;
        const level = result.riskManagement.nearestBlockingLevel;
        if (required && level) {
            return `Для R/R >= 1.8 long-вход должен быть не выше ${required}, либо нужно пробить ${level} и сформировать новый чистый путь к TP после ретеста. Старая зона ретеста выше этого уровня невалидна по текущей R/R-геометрии без новой локальной структуры.`;
        }
        if (required) {
            return `Для R/R >= 1.8 вход должен быть около ${required} или лучше.`;
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
