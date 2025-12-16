// src/services/TelegramService.ts

import TelegramBot, { Message } from 'node-telegram-bot-api';
import { DatabaseService, LiquidationData } from './DatabaseService';
import { ReportingService } from './ReportingService';
import { MarketDataService, OISurge } from './MarketDataService';
import { SYMBOLS_TO_TRACK, TELEGRAM_CHANNEL_ID, CHANNEL_MIN_LIQUIDATION } from '../config';

type UserState = 'awaiting_threshold';
const PAIRS_PAGE_SIZE = 30;

// Определение типа CascadeBuffer (локальное, чтобы избежать ошибок импорта)
export type CascadeBuffer = {
    count: number;
    totalVolume: number;
    minPrice: number;
    maxPrice: number;
    side: 'long' | 'short';
    startTime: number;
};

export class TelegramService {
    private bot: TelegramBot;
    private dbService: DatabaseService;
    private reportingService: ReportingService;
    private marketDataService: MarketDataService;
    private readonly reportIntervals = [1, 4, 12, 24];
    private userStates: Map<number, UserState> = new Map();

    constructor(
        token: string,
        dbService: DatabaseService,
        reportingService: ReportingService,
        marketDataService: MarketDataService
    ) {
        this.bot = new TelegramBot(token, { polling: true });
        this.dbService = dbService;
        this.reportingService = reportingService;
        this.marketDataService = marketDataService;
        this.listenForCommands();
        console.log(`✅ TelegramService initialized. Channel Mode: ${TELEGRAM_CHANNEL_ID ? 'ON' : 'OFF'}`);
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

    // --- ALERT: OI SURGE (АВТОМАТИЧЕСКОЕ ОПОВЕЩЕНИЕ) ---
    public async sendOISurgeAlert(surge: OISurge): Promise<void> {
        const isPositive = surge.percentChange > 0;
        const emoji = isPositive ? '📈' : '📉';
        const action = isPositive ? 'INCREASED' : 'DROPPED';
        const color = isPositive ? '🟢' : '🔴';

        const message = `${emoji} *OI ALERT: ${surge.symbol}*\n\n` +
                        `${color} Open Interest ${action} by *${surge.percentChange.toFixed(2)}%* in 15 min!\n\n` +
                        `💵 Price: $${surge.price}\n` +
                        `💰 New OI: *$${(surge.currentOI / 1000000).toFixed(2)}M*`;

        // 1. ОТПРАВКА В КАНАЛ
        if (TELEGRAM_CHANNEL_ID) {
            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ОТПРАВКА ПОДПИСЧИКАМ
        const users = await this.dbService.findUsersTrackingSymbol(surge.symbol);
        for (const user of users) {
            if (user.notificationsEnabled) {
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

        // 1. ОТПРАВКА В КАНАЛ (Если объем каскада больше минимума)
        if (TELEGRAM_CHANNEL_ID && buffer.totalVolume >= CHANNEL_MIN_LIQUIDATION) {
            await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ОТПРАВКА ПОДПИСЧИКАМ
        const users = await this.dbService.findUsersTrackingSymbol(symbol);
        for (const user of users) {
            if (user.notificationsEnabled && buffer.totalVolume >= user.minLiquidationAlert) {
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
            if (ex.fundingRate > 0.0001) icon = '🔥'; // Высокий фандинг
            if (ex.fundingRate < 0) icon = '🧊';      // Отрицательный фандинг

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

        let sentiment = 'Neutral 😐';
        if (stats.longShortRatio > 2.5) sentiment = 'Over-longed (Bearish) 🐻';
        else if (stats.longShortRatio < 0.6) sentiment = 'Over-shorted (Bullish) 🐮';

        const msgText = `⚖️ *${stats.symbol} Long/Short Ratio (Top Traders)*\n\n` +
                        `Ratio: *${stats.longShortRatio.toFixed(2)}*\n` +
                        `Sentiment: ${sentiment}`;

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
            
            // Positive (>0) = Longs pay Shorts = Danger for Longs (Long Squeeze)
            message += `🔥 *Highest (Potential Long Squeeze):*\n`; 
            high.forEach((d, i) => message += `${i+1}. ${formatRate(d)}\n`);
            
            // Negative (<0) = Shorts pay Longs = Danger for Shorts (Short Squeeze)
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
        const text = '⚙️ *Settings*\n\nChoose what you want to configure:';
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⏰ Report Interval', callback_data: 'menu:interval' }],
                    [{ text: '💰 Alert Threshold', callback_data: 'menu:threshold' }],
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

        // 1. ОТПРАВКА В КАНАЛ (Если задан ID и объем > минимума)
        if (TELEGRAM_CHANNEL_ID && value >= CHANNEL_MIN_LIQUIDATION) {
             await this.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }

        // 2. ОТПРАВКА ЮЗЕРАМ
        const users = await this.dbService.findUsersTrackingSymbol(liquidation.symbol);
        if (users.length === 0) return;

        for (const user of users) {
            if (user.notificationsEnabled && value >= user.minLiquidationAlert) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    public async sendMessage(chatId: string | number, message: string, options: any = { parse_mode: 'Markdown' }): Promise<void> {
        try {
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

    private async deleteMessage(chatId: number, messageId: number): Promise<void> {
        try {
            await this.bot.deleteMessage(chatId, messageId);
        } catch (error: any) {
             // Ignore if not found
        }
    }
}