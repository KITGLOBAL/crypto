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
    private telegramService!: TelegramService; 

    constructor(dbService: DatabaseService) {
        this.dbService = dbService;
        console.log('ReportingService initialized.');
    }

    public setTelegramService(telegramService: TelegramService): void {
        this.telegramService = telegramService;
    }

    public start(): void {
        const reportCronPattern = '0 * * * *';
        console.log(`🚀 Scheduled reporting service with cron pattern: "${reportCronPattern}"`);
        cron.schedule(reportCronPattern, () => {
            console.log('🕒 Cron job triggered: Checking for scheduled reports...');
            this.generateAndSendScheduledReports();
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

    public async generateAndSendScheduledReports(): Promise<void> {
        console.log('Checking schedules for automated reports...');
        const activeUsers = await this.dbService.getActiveUsers();
        if (activeUsers.length === 0) return;

        const currentHour = new Date().getHours();
        for (const user of activeUsers) {
            if (currentHour % user.reportIntervalHours === 0) {
                console.log(`[${user.chatId}] It's time for their scheduled ${user.reportIntervalHours}-hour report. Generating...`);
                const reportMessage = await this.generateReportForUser(user, user.reportIntervalHours, true);
                if (reportMessage) {
                    await this.telegramService.sendMessage(user.chatId, reportMessage);
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
                if (liq.side === 'long liquidation') symbolLongsValue += value;
                else symbolShortsValue += value;
            }
            if (symbolLongsValue > 0 || symbolShortsValue > 0) {
                 statsMap.set(symbol, { longs: symbolLongsValue, shorts: symbolShortsValue });
            }
        }
        return statsMap;
    }

    public async generateReportForUser(user: User, intervalHours: number, isScheduled: boolean = false): Promise<string | null> {
        const now = new Date();
        let reportPeriodStart: Date, reportPeriodEnd: Date;
        let previousPeriodStart: Date, previousPeriodEnd: Date;
        let reportTitle: string;

        if (isScheduled) {
            reportPeriodEnd = new Date(now);
            reportPeriodStart = new Date(reportPeriodEnd);
            reportPeriodStart.setHours(reportPeriodStart.getHours() - intervalHours);
            
            previousPeriodEnd = new Date(reportPeriodStart);
            previousPeriodStart = new Date(previousPeriodEnd);
            previousPeriodStart.setHours(previousPeriodStart.getHours() - intervalHours);
            reportTitle = `*${intervalHours}-Hour Liquidation Report* 📊\n_(Compared to the previous ${intervalHours} hours)_`;
        } else {
            reportPeriodEnd = new Date(now);
            reportPeriodStart = new Date(now);
            reportPeriodStart.setMinutes(0, 0, 0);

            previousPeriodEnd = new Date(reportPeriodStart);
            previousPeriodStart = new Date(previousPeriodEnd);
            previousPeriodStart.setHours(previousPeriodStart.getHours() - intervalHours);
            reportTitle = `*Live Report for Current Hour* 📊\n_(Compared to the previous full hour)_`;
        }

        const currentStats = await this.getStatsForPeriod(user.trackedSymbols, reportPeriodStart, reportPeriodEnd);
        const previousStats = await this.getStatsForPeriod(user.trackedSymbols, previousPeriodStart, previousPeriodEnd);

        if (currentStats.size === 0) {
            return `No liquidations recorded for your tracked pairs in the current period.`;
        }

        let longsReport = '';
        let shortsReport = '';
        let totalLongsValue = 0;
        let totalShortsValue = 0;

        for (const symbol of currentStats.keys()) {
            const current = currentStats.get(symbol)!;
            const previous = previousStats.get(symbol) || { longs: 0, shorts: 0 };
            
            let comparisonLongs = previous.longs;
            let comparisonShorts = previous.shorts;
            if(!isScheduled){
                 const minutesPassed = (reportPeriodEnd.getTime() - reportPeriodStart.getTime()) / (1000 * 60);
                 const scaleFactor = minutesPassed / (intervalHours * 60);
                 comparisonLongs *= scaleFactor;
                 comparisonShorts *= scaleFactor;
            }

            if (current.longs > 0) {
                let trend = '';
                if (current.longs > comparisonLongs) trend = ' ⬆️';
                else if (current.longs < comparisonLongs) trend = ' ⬇️';
                longsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.longs)}${trend}\n`;
                totalLongsValue += current.longs;
            }
            if (current.shorts > 0) {
                let trend = '';
                if (current.shorts > comparisonShorts) trend = ' ⬆️';
                else if (current.shorts < comparisonShorts) trend = ' ⬇️';
                shortsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.shorts)}${trend}\n`;
                totalShortsValue += current.shorts;
            }
        }
        
        const getTopThree = (side: 'longs' | 'shorts') => {
            return Array.from(currentStats.entries())
                .filter(([, stats]) => stats[side] > 0)
                .sort((a, b) => b[1][side] - a[1][side])
                .slice(0, 3)
                .map(([symbol, stats], index) => {
                    const medals = ['🥇', '🥈', '🥉'];
                    return `    ${medals[index]} ${symbol}: $${this.formatCurrency(stats[side])}`;
                })
                .join('\n');
        };

        const topLongs = getTopThree('longs');
        const topShorts = getTopThree('shorts');
        let topMoversReport = '';

        if(topLongs || topShorts){
            topMoversReport = '*Top rekted rank* 🏆\n';
            if(topLongs) topMoversReport += `  *Top Long Liquidations:*\n${topLongs}\n`;
            if(topShorts) topMoversReport += `  *Top Short Liquidations:*\n${topShorts}\n`;
        }

        let finalReport = `${reportTitle}\n\n`;

        if (longsReport) {
            finalReport += `*🔴 LONGS LIQUIDATED*\n${longsReport}  *Subtotal: $${this.formatCurrency(totalLongsValue)}*\n\n`;
        }
        if (shortsReport) {
            finalReport += `*🟢 SHORTS LIQUIDATED*\n${shortsReport}  *Subtotal: $${this.formatCurrency(totalShortsValue)}*\n\n`;
        }
        
        if (!longsReport && !shortsReport) return null;
        
        finalReport += `*OVERALL TOTAL:*\n  🔴 Longs: $${this.formatCurrency(totalLongsValue)}\n  🟢 Shorts: $${this.formatCurrency(totalShortsValue)}\n\n`;

        if (topMoversReport) {
            finalReport += `${topMoversReport}`;
        }

        return finalReport;
    }
}