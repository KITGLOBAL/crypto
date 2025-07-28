// src/services/TelegramService.ts

import TelegramBot, { Message } from 'node-telegram-bot-api';
import { DatabaseService } from './DatabaseService';
import { SYMBOLS_TO_TRACK } from '../config';

export class TelegramService {
    private bot: TelegramBot;
    private dbService: DatabaseService;

    constructor(token: string, dbService: DatabaseService) {
        this.bot = new TelegramBot(token, { polling: true });
        this.dbService = dbService;
        this.listenForCommands();
        console.log('TelegramService initialized in interactive mode.');
    }

    private listenForCommands(): void {
        this.bot.onText(/\/start/, this.handleStart.bind(this));
        this.bot.onText(/\/settings/, this.handleSettings.bind(this));
        this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    }

    private async handleStart(msg: Message): Promise<void> {
        const { id: chatId, first_name: firstName, username } = msg.chat;
        await this.dbService.findOrCreateUser(chatId, firstName, username);
        const displayName = firstName || 'незнакомец';
        const welcomeMessage = `👋 Привет, ${displayName}!\n\nЯ бот для отслеживания криптовалютных ликвидаций. Я буду присылать вам ежечасный отчет по выбранным парам.\n\nИспользуйте команду /settings, чтобы настроить список монет.`;
        this.bot.sendMessage(chatId, welcomeMessage);
    }
    
    private async handleSettings(msg: Message): Promise<void> {
        const chatId = msg.chat.id;
        const user = await this.dbService.getUser(chatId);
        if (!user) {
            await this.handleStart(msg);
            return;
        }
        const options = {
            reply_markup: {
                inline_keyboard: this.generateKeyboard(user.trackedSymbols)
            }
        };
        this.bot.sendMessage(chatId, '⚙️ Выберите пары для отслеживания. Нажмите на монету, чтобы добавить или убрать ее из списка.', options);
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.message || !query.data) return;

        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const [action, payload] = query.data.split(':');

        if (action === 'toggle') {
            const updatedUser = await this.dbService.toggleSymbolForUser(chatId, payload);
            if (updatedUser) {
                await this.bot.editMessageReplyMarkup({
                    inline_keyboard: this.generateKeyboard(updatedUser.trackedSymbols)
                }, {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
            await this.bot.answerCallbackQuery(query.id);
        } else if (action === 'close') {
            try {
                await this.bot.deleteMessage(chatId, messageId);
            } catch (error: any) {
                if (error.response?.body?.description?.includes('message to delete not found')) {
                    console.warn(`Attempted to delete a message (ID: ${messageId}) that was already gone. Suppressing error.`);
                } else {
                    console.error(`Failed to delete message (ID: ${messageId}):`, error);
                }
            }
            await this.bot.answerCallbackQuery(query.id);
        }
    }

    private generateKeyboard(userSymbols: string[]): TelegramBot.InlineKeyboardButton[][] {
        const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
        const userSymbolsSet = new Set(userSymbols);
        for (let i = 0; i < SYMBOLS_TO_TRACK.length; i += 2) {
            const row: TelegramBot.InlineKeyboardButton[] = [];
            const symbol1 = SYMBOLS_TO_TRACK[i];
            const symbol2 = SYMBOLS_TO_TRACK[i + 1];
            if (symbol1) {
                const text1 = userSymbolsSet.has(symbol1) ? `✅ ${symbol1}` : symbol1;
                row.push({ text: text1, callback_data: `toggle:${symbol1}` });
            }
            if (symbol2) {
                const text2 = userSymbolsSet.has(symbol2) ? `✅ ${symbol2}` : symbol2;
                row.push({ text: text2, callback_data: `toggle:${symbol2}` });
            }
            keyboard.push(row);
        }
        keyboard.push([{ text: '❌ Закрыть', callback_data: 'close:menu' }]);
        return keyboard;
    }

    public async sendMessage(chatId: string | number, message: string): Promise<void> {
        try {
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            console.log(`✅ Message sent to Telegram chat ${chatId}`);
        } catch (error: any) {
            console.error(`❌ Failed to send message to Telegram chat ${chatId}: ${error.message}`);
        }
    }
}