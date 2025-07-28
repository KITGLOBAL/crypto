// src/services/TelegramService.ts

import TelegramBot, { Message } from 'node-telegram-bot-api';
import { DatabaseService, User, LiquidationData } from './DatabaseService';
import { ReportingService } from './ReportingService';
import { SYMBOLS_TO_TRACK } from '../config';

type UserState = 'awaiting_threshold';
const PAIRS_PAGE_SIZE = 30;

export class TelegramService {
    private bot: TelegramBot;
    private dbService: DatabaseService;
    private reportingService: ReportingService;
    private readonly reportIntervals = [1, 4, 12, 24];
    private userStates: Map<number, UserState> = new Map();

    constructor(token: string, dbService: DatabaseService, reportingService: ReportingService) {
        this.bot = new TelegramBot(token, { polling: true });
        this.dbService = dbService;
        this.reportingService = reportingService;
        this.listenForCommands();
        console.log('TelegramService initialized in interactive mode.');
    }

    private listenForCommands(): void {
        this.bot.onText(/\/start/, this.handleStart.bind(this));
        this.bot.onText(/📢 Report Now/, this.handleReportNow.bind(this));
        this.bot.onText(/📊 Market Stats/, this.handleMarketStats.bind(this));
        this.bot.onText(/⚙️ Settings/, this.handleSettings.bind(this));
        this.bot.onText(/🔇 Mute Alerts|🔊 Unmute Alerts/, this.handleMuteToggle.bind(this));
        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
        this.bot.on('message', this.handleMessage.bind(this));
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
        if (totalLongsValue > totalShortsValue) {
            dominanceMessage = 'Longs liquidations are dominating.';
        } else if (totalShortsValue > totalLongsValue) {
            dominanceMessage = 'Shorts liquidations are dominating.';
        } else {
            dominanceMessage = 'The market is balanced.';
        }

        const reportMessage = `*Market Stats for the Last 24 Hours* 📈\n\n` +
                              `🔴 Total Longs: *${formatValue(totalLongsValue)}*\n` +
                              `🟢 Total Shorts: *${formatValue(totalShortsValue)}*\n\n` +
                              `_${dominanceMessage}_`;

        await this.bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
    }

    private async handleReportNow(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);
    
        if (!user) {
            this.bot.sendMessage(chatId, 'Please run /start first.');
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

    private generateMainMenuKeyboard(user: User): TelegramBot.ReplyKeyboardMarkup {
        const muteButtonText = user.notificationsEnabled ? '🔇 Mute Alerts' : '🔊 Unmute Alerts';
        return {
            keyboard: [
                [{ text: '📢 Report Now' }, { text: '📊 Market Stats'}],
                [{ text: muteButtonText }, { text: '⚙️ Settings' }]
            ],
            resize_keyboard: true,
        };
    }
    
    private async handleMuteToggle(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const updatedUser = await this.dbService.toggleUserNotifications(chatId);

        if (updatedUser) {
            const newStatus = updatedUser.notificationsEnabled;
            let confirmationMessage = '';

            if (newStatus) { 
                confirmationMessage = 'Silent mode is now deactivated. You will resume receiving real-time liquidation alerts.';
            } else {
                confirmationMessage = 'Silent mode is now active. You will no longer receive real-time liquidation alerts, only your scheduled reports.';
            }
            
            this.bot.sendMessage(chatId, confirmationMessage, {
                reply_markup: this.generateMainMenuKeyboard(updatedUser)
            });

        } else {
            this.bot.sendMessage(chatId, "Could not find your user profile. Please try /start again.");
        }
    }

    private async handleMessage(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        if (msg.text) {
            const commandText = msg.text;
            const handledCommands = ['/start', '📢 Report Now', '📊 Market Stats', '⚙️ Settings', '🔇 Mute Alerts', '🔊 Unmute Alerts'];
            if(handledCommands.includes(commandText)) return;
        }

        const currentState = this.userStates.get(chatId);
        if (currentState === 'awaiting_threshold') {
            const newThreshold = parseInt(msg.text || '', 10);
            if (!isNaN(newThreshold) && newThreshold >= 0) {
                await this.dbService.updateUserAlertThreshold(chatId, newThreshold);
                this.userStates.delete(chatId);
                
                const confirmationMessage = `✅ Great! Real-time alerts will now only be shown for liquidations over *$${newThreshold.toLocaleString('en-US')}*.`;
                await this.bot.sendMessage(chatId, confirmationMessage, { parse_mode: 'Markdown' });

            } else {
                await this.bot.sendMessage(chatId, "That doesn't look right. Please send a valid number (e.g., `50000`) to set your alert threshold.", {parse_mode: 'Markdown'});
            }
        }
    }

    private async handleStart(msg: Message): Promise<void> {
        const { id: chatId, first_name: firstName, username } = msg.chat;
        const user = await this.dbService.findOrCreateUser(chatId, firstName, username); 
        const displayName = firstName || 'there';
        const welcomeMessage = `👋 Hello, ${displayName}!\n\nI am a cryptocurrency liquidations tracking bot. I will send you real-time alerts for large liquidations and periodic summary reports.\n\nUse the buttons below to configure your preferences.`;
        
        this.bot.sendMessage(chatId, welcomeMessage, {
            reply_markup: this.generateMainMenuKeyboard(user)
        });
    }
    
    private async handleSettings(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);
        if (!user) {
            this.bot.sendMessage(chatId, 'Please run /start first.');
            return;
        }

        const text = '⚙️ *Settings*\n\nChoose what you want to configure:';
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Tracked Pairs', callback_data: 'menu:pairs:0' }],
                    [{ text: '⏰ Aggregate data interval', callback_data: 'menu:interval' }],
                    [{ text: '💰 Alert Threshold', callback_data: 'menu:threshold' }],
                    [{ text: '❌ Close', callback_data: 'menu:close' }]
                ]
            }
        };
        this.bot.sendMessage(chatId, text, options);
    }
    
    private async showMainSettings(chatId: number, messageId: number): Promise<void> {
        const text = '⚙️ *Settings*\n\nChoose what you want to configure:';
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Tracked Pairs', callback_data: 'menu:pairs:0' }],
                    [{ text: '⏰ Aggregate data interval', callback_data: 'menu:interval' }],
                    [{ text: '💰 Alert Threshold', callback_data: 'menu:threshold' }],
                    [{ text: '❌ Close', callback_data: 'menu:close' }]
                ]
            }
        };
        try {
            await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } catch(e) {
            console.error("Failed to edit message for main settings", e);
        }
    }
    
    private async showPairsSettings(chatId: number, messageId: number, page: number): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;
        
        const text = 'Select the pairs you want to track. Tap a coin to add or remove it from your list.';
        const keyboard = this.generatePairsKeyboard(user.trackedSymbols, page);
        
        try {
            await this.bot.editMessageText(text, { 
                chat_id: chatId, 
                message_id: messageId, 
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (error: any) {
            if (!error.response?.body?.description?.includes('message is not modified')) {
                console.error(`Failed to edit message for pair settings:`, error);
            }
        }
    }

    private async showIntervalSettings(chatId: number, messageId: number): Promise<void> {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;

        const text = `Your current data aggregation interval is *${user.reportIntervalHours} hours*. Select a new interval below.`;
        const options = {
            parse_mode: 'Markdown' as const,
            reply_markup: {
                inline_keyboard: this.generateIntervalKeyboard(user.reportIntervalHours)
            }
        };
        await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    }

    private async showThresholdSettings(chatId: number, messageId: number) {
        const user = await this.dbService.getUser(chatId);
        if (!user) return;
        
        this.userStates.set(chatId, 'awaiting_threshold');

        const text = `Your current alert threshold is *$${user.minLiquidationAlert.toLocaleString('en-US')}*. \n\nPlease send a new value to update it. For example, to set the threshold to $50,000, just send the number \`50000\`.`;
        
        await this.deleteMessage(chatId, messageId);
        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.message || !query.data) return;

        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const [action, payload, pageStr] = query.data.split(':');
        const page = parseInt(pageStr || '0', 10);

        if (action === 'menu') {
            if (payload === 'pairs') {
                await this.showPairsSettings(chatId, messageId, page);
            } else if (payload === 'interval') {
                await this.showIntervalSettings(chatId, messageId);
            } else if (payload === 'threshold') {
                await this.showThresholdSettings(chatId, messageId);
            } else if (payload === 'settings_main') {
                await this.showMainSettings(chatId, messageId);
            } else if (payload === 'close') {
                await this.deleteMessage(chatId, messageId);
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
            const newInterval = parseInt(payload, 10);
            const currentUser = await this.dbService.getUser(chatId);

            if (currentUser && currentUser.reportIntervalHours === newInterval) {
                await this.bot.answerCallbackQuery(query.id, { text: "This is already your current interval." });
                return;
            }

            const updatedUser = await this.dbService.updateUserReportInterval(chatId, newInterval);
            if (updatedUser) {
                await this.showIntervalSettings(chatId, messageId);
                const explanation = `Great! You will now receive a report summarizing all liquidations every *${newInterval} hours*.`;
                this.bot.sendMessage(chatId, explanation, { parse_mode: 'Markdown' });
            }
        } else if (action === 'noop') {

        }
        
        await this.bot.answerCallbackQuery(query.id);
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
            if (page > 0) {
                navigationRow.push({ text: '◀️ Prev', callback_data: `menu:pairs:${page - 1}` });
            }
            navigationRow.push({ text: `· ${page + 1}/${totalPages} ·`, callback_data: 'noop' });
            if (page < totalPages - 1) {
                navigationRow.push({ text: 'Next ▶️', callback_data: `menu:pairs:${page + 1}` });
            }
            keyboard.push(navigationRow);
        }

        keyboard.push([
            { text: '✅ Select All', callback_data: `set_all_pairs:select:${page}` },
            { text: '❌ Deselect All', callback_data: `set_all_pairs:deselect:${page}` }
        ]);
        keyboard.push([{ text: '⬅️ Back to Settings', callback_data: 'menu:settings_main:0' }]);
        
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
    
    public async sendRealtimeLiquidationAlert(liquidation: LiquidationData): Promise<void> {
        const users = await this.dbService.findUsersTrackingSymbol(liquidation.symbol);
        if (users.length === 0) return;

        const value = liquidation.price * liquidation.quantity;
        const isLarge = value >= 500000;
        const isWhale = value >= 1000000;
        
        let icon = '';
        if (liquidation.side === 'long liquidation') {
            icon = isLarge ? '🚨💀🔴' : '🔴';
        } else {
            icon = isLarge ? '🚀💰🟢' : '🟢';
        }

        const rektType = liquidation.side === 'long liquidation' ? 'Long' : 'Short';
        const formattedValue = value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : `${(value / 1000).toFixed(0)}K`;
        
        let message = `${icon} *#${liquidation.symbol} REKT ${rektType}:* $${formattedValue} at $${liquidation.price.toLocaleString('en-US')}`;

        if (isWhale) {
            message = `🔥 *WHALE ALERT!* 🔥\n${message}`;
        }

        for (const user of users) {
            if (value >= user.minLiquidationAlert) {
                await this.sendMessage(user.chatId, message);
            }
        }
    }

    public async sendMessage(chatId: string | number, message: string, options: any = { parse_mode: 'Markdown' }): Promise<void> {
        try {
            await this.bot.sendMessage(chatId, message, options);
        } catch (error: any) {
            if (error.response?.body?.error_code === 403) {
                console.warn(`[${chatId}] Bot was blocked by the user. Deactivating notifications.`);
            } else {
                 console.error(`❌ Failed to send message to Telegram chat ${chatId}: ${error.message}`);
            }
        }
    }

    private async deleteMessage(chatId: number, messageId: number): Promise<void> {
        try {
            await this.bot.deleteMessage(chatId, messageId);
        } catch (error: any) {
             if (error.response?.body?.description?.includes('message to delete not found')) {
            } else {
                console.error(`Failed to delete message (ID: ${messageId}):`, error);
            }
        }
    }
}