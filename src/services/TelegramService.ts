// src/services/TelegramService.ts

import TelegramBot from 'node-telegram-bot-api';

export class TelegramService {
    private bot: TelegramBot;

    constructor(token: string) {
        this.bot = new TelegramBot(token);
        console.log('TelegramService initialized.');
    }

    public async sendMessage(chatId: string, message: string): Promise<void> {
        try {
            await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            console.log(`✅ Message sent to Telegram chat ${chatId}`);
        } catch (error: any) {
            console.error(`❌ Failed to send message to Telegram: ${error.message}`);
        }
    }
}
