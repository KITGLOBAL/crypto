// src/services/ReportingService.ts

import cron from 'node-cron';
import { DatabaseService } from './DatabaseService';
import { TelegramService } from './TelegramService';

export class ReportingService {
    private dbService: DatabaseService;
    private telegramService: TelegramService;
    private symbols: string[];
    private chatId: string;

    constructor(
        dbService: DatabaseService,
        telegramService: TelegramService,
        symbols: string[],
        chatId: string
    ) {
        this.dbService = dbService;
        this.telegramService = telegramService;
        this.symbols = symbols;
        this.chatId = chatId;
        console.log('ReportingService initialized.');
    }

    public start(): void {
        const cronPattern = '0 * * * *';
        
        console.log(`🚀 Reporting service scheduled with cron pattern: "${cronPattern}"`);
        cron.schedule(cronPattern, () => {
            console.log('🕒 Cron job triggered: Generating hourly report...');
            this.generateAndSendReport();
        });
    }

    public async generateAndSendReport(): Promise<void> {
        const since = new Date(Date.now() - 60 * 60 * 1000);
        
        let reportMessage = `*Hourly Liquidation Report* 📊\n_(since ${since.toLocaleTimeString('ru-RU')})_\n\n`;
        let totalLongsValue = 0;
        let totalShortsValue = 0;

        for (const symbol of this.symbols) {
            const liquidations = await this.dbService.getLiquidationsSince(symbol, since);
            if (liquidations.length === 0) continue;

            let symbolLongsValue = 0;
            let symbolShortsValue = 0;
            let symbolLongsCount = 0;
            let symbolShortsCount = 0;

            for (const liq of liquidations) {
                const value = liq.price * liq.quantity;
                if (liq.side === 'long liquidation') {
                    symbolLongsValue += value;
                    symbolLongsCount++;
                } else {
                    symbolShortsValue += value;
                    symbolShortsCount++;
                }
            }
            
            reportMessage += `*${symbol}*:\n`;
            reportMessage += `  🔴 Longs: ${symbolLongsCount} ($${symbolLongsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})\n`;
            reportMessage += `  🟢 Shorts: ${symbolShortsCount} ($${symbolShortsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})\n`;
            
            totalLongsValue += symbolLongsValue;
            totalShortsValue += symbolShortsValue;
        }

        if (totalLongsValue > 0 || totalShortsValue > 0) {
            reportMessage += `\n*Overall Total:*\n`;
            reportMessage += `  🔴 Total Longs: $${totalLongsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
            reportMessage += `  🟢 Total Shorts: $${totalShortsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
        } else {
            reportMessage += `No liquidations in the last hour. ✨`;
        }


        await this.telegramService.sendMessage(this.chatId, reportMessage);
    }
}