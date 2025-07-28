// src/services/ReportingService.ts

import cron from 'node-cron';
import { DatabaseService, User } from './DatabaseService';
import { TelegramService } from './TelegramService';

type LiquidationStats = {
    longs: number;
    shorts: number;
};

export class ReportingService {
    private dbService: DatabaseService;
    private telegramService: TelegramService;

    constructor(dbService: DatabaseService, telegramService: TelegramService) {
        this.dbService = dbService;
        this.telegramService = telegramService;
        console.log('ReportingService initialized.');
    }

    public start(): void {
        const reportCronPattern = '0 * * * *';
        console.log(`🚀 Reporting service scheduled with cron pattern: "${reportCronPattern}"`);
        cron.schedule(reportCronPattern, () => {
            console.log('🕒 Cron job triggered: Checking which users need reports...');
            this.generateAndSendReports();
        });

        const cleanupCronPattern = '0 0 * * *';
        console.log(`🧹 Database cleanup service scheduled with cron pattern: "${cleanupCronPattern}"`);
        cron.schedule(cleanupCronPattern, () => {
            console.log('🗑️ Cron job triggered: Cleaning up old database records...');
            this.cleanupOldData();
        });
    }

    private async cleanupOldData(): Promise<void> {
        const fortyEightHoursAgo = new Date();
        fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);
        await this.dbService.deleteOldLiquidations(fortyEightHoursAgo);
    }

    public async generateAndSendReports(): Promise<void> {
        const activeUsers = await this.dbService.getActiveUsers();
        if (activeUsers.length === 0) {
            console.log('No active users to report to.');
            return;
        }

        console.log(`Found ${activeUsers.length} active users. Checking schedules...`);
        const currentHour = new Date().getHours();

        for (const user of activeUsers) {
            if (currentHour % user.reportIntervalHours === 0) {
                console.log(`[${user.chatId}] It's time for their ${user.reportIntervalHours}-hour report. Generating...`);
                const reportMessage = await this.generateReportForUser(user, user.reportIntervalHours);
                if (reportMessage) {
                    await this.telegramService.sendMessage(user.chatId, reportMessage);
                } else {
                    console.log(`[${user.chatId}] No significant liquidations to report in the last ${user.reportIntervalHours} hours.`);
                }
            }
        }
    }

    private formatCurrency(value: number): string {
        return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    private async getStatsForPeriod(symbols: string[], startTime: Date, endTime: Date): Promise<Map<string, LiquidationStats>> {
        const statsMap = new Map<string, LiquidationStats>();
        for (const symbol of symbols) {
            const liquidations = await this.dbService.getLiquidationsBetween(symbol, startTime, endTime);
            if (liquidations.length === 0) continue;

            let symbolLongsValue = 0;
            let symbolShortsValue = 0;

            for (const liq of liquidations) {
                const value = liq.price * liq.quantity;
                if (liq.side === 'long liquidation') {
                    symbolLongsValue += value;
                } else {
                    symbolShortsValue += value;
                }
            }
            if (symbolLongsValue > 0 || symbolShortsValue > 0) {
                 statsMap.set(symbol, { longs: symbolLongsValue, shorts: symbolShortsValue });
            }
        }
        return statsMap;
    }

    private async generateReportForUser(user: User, intervalHours: number): Promise<string | null> {
        const now = new Date();
        const reportPeriodEnd = now;
        const reportPeriodStart = new Date(reportPeriodEnd);
        reportPeriodStart.setHours(reportPeriodStart.getHours() - intervalHours);
        
        const previousPeriodStart = new Date(reportPeriodStart);
        previousPeriodStart.setHours(previousPeriodStart.getHours() - intervalHours);
        
        const currentStats = await this.getStatsForPeriod(user.trackedSymbols, reportPeriodStart, reportPeriodEnd);
        const previousStats = await this.getStatsForPeriod(user.trackedSymbols, previousPeriodStart, reportPeriodStart);

        if (currentStats.size === 0) {
            return null; 
        }

        let longsReport = '';
        let shortsReport = '';
        let totalLongsValue = 0;
        let totalShortsValue = 0;

        for (const symbol of currentStats.keys()) {
            const current = currentStats.get(symbol)!;
            const previous = previousStats.get(symbol) || { longs: 0, shorts: 0 };

            if (current.longs > 0) {
                let trend = '';
                if (current.longs > previous.longs) {
                    trend = ' ⬆️';
                } else if (current.longs < previous.longs) {
                    trend = ' ⬇️';
                }
                longsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.longs)}${trend}\n`;
                totalLongsValue += current.longs;
            }
            if (current.shorts > 0) {
                let trend = '';
                if (current.shorts > previous.shorts) {
                    trend = ' ⬆️';
                } else if (current.shorts < previous.shorts) {
                    trend = ' ⬇️';
                }
                shortsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.shorts)}${trend}\n`;
                totalShortsValue += current.shorts;
            }
        }
        
        let finalReport = `*${intervalHours}-Hour Liquidation Report* 📊\n_(Compared to the previous ${intervalHours} hours)_\n\n`;

        if (longsReport) {
            finalReport += `*🔴 LONGS LIQUIDATED*\n${longsReport}  *Subtotal: $${this.formatCurrency(totalLongsValue)}*\n\n`;
        }
        if (shortsReport) {
            finalReport += `*🟢 SHORTS LIQUIDATED*\n${shortsReport}  *Subtotal: $${this.formatCurrency(totalShortsValue)}*\n\n`;
        }
        
        if (!longsReport && !shortsReport) return null;

        finalReport += `*OVERALL TOTAL:*\n  🔴 Longs: $${this.formatCurrency(totalLongsValue)}\n  🟢 Shorts: $${this.formatCurrency(totalShortsValue)}\n`;

        return finalReport;
    }
}