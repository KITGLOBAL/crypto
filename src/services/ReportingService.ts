// src/services/ReportingService.ts

import cron from 'node-cron';
import { DatabaseService, User } from './DatabaseService';
import { TelegramService } from './TelegramService';
import { MarketDataService } from './MarketDataService';
import { SYMBOLS_TO_TRACK } from '../config';

type LiquidationStats = {
    longs: number;
    shorts: number;
};

export class ReportingService {
    private dbService: DatabaseService;
    private marketDataService: MarketDataService;
    private telegramService!: TelegramService; 

    constructor(dbService: DatabaseService, marketDataService: MarketDataService) {
        this.dbService = dbService;
        this.marketDataService = marketDataService;
        console.log('✅ ReportingService initialized.');
    }

    public setTelegramService(telegramService: TelegramService): void {
        this.telegramService = telegramService;
    }

    public start(): void {
        // 1. ОТЧЕТЫ ЮЗЕРАМ: Каждый час
        cron.schedule('0 * * * *', () => {
            console.log('🕒 Hourly report check...');
            this.generateAndSendScheduledReports();
        });

        // 2. ЧИСТКА БД: Полночь
        cron.schedule('0 0 * * *', () => {
            this.cleanupOldData();
        });

        // 3. OI MONITOR: ТЕПЕРЬ КАЖДЫЙ ЧАС (в 00 минут)
        // Чтобы уменьшить спам и ловить только крупные тренды
        console.log('🚀 OI Monitor scheduled (Hourly)');
        cron.schedule('0 * * * *', () => {
            this.checkOpenInterestSurges();
        });

        // 4. КАНАЛ: Фандинг каждые 4 часа
        cron.schedule('0 */4 * * *', () => {
            console.log('📢 Broadcasting Funding to Channel...');
            this.telegramService.broadcastTopFunding();
        });

        // 5. КАНАЛ: Итоги суток (в 9 утра)
        cron.schedule('0 9 * * *', () => {
            console.log('📊 Broadcasting Daily Stats to Channel...');
            this.telegramService.broadcastDailyStats();
        });
    }

    private async checkOpenInterestSurges(): Promise<void> {
        try {
            const surges = await this.marketDataService.checkOIFluctuations(SYMBOLS_TO_TRACK);
            
            if (surges.length > 0) {
                console.log(`🚨 Detected ${surges.length} OI surges. Sending alerts...`);
                for (const surge of surges) {
                    await this.telegramService.sendOISurgeAlert(surge);
                }
            }
        } catch (error) {
            console.error('❌ Error in OI Monitor:', error);
        }
    }

    private async cleanupOldData(): Promise<void> {
        const fortyEightHoursAgo = new Date();
        fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);
        await this.dbService.deleteOldLiquidations(fortyEightHoursAgo);
    }

    public async generateAndSendScheduledReports(): Promise<void> {
        const activeUsers = await this.dbService.getActiveUsers();
        if (activeUsers.length === 0) return;

        const currentHour = new Date().getHours();
        for (const user of activeUsers) {
            if (currentHour % user.reportIntervalHours === 0) {
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
            reportTitle = `*${intervalHours}-Hour Liquidation Report* 📊`;
        } else {
            reportPeriodEnd = new Date(now);
            reportPeriodStart = new Date(now);
            reportPeriodStart.setMinutes(0, 0, 0);

            previousPeriodEnd = new Date(reportPeriodStart);
            previousPeriodStart = new Date(previousPeriodEnd);
            previousPeriodStart.setHours(previousPeriodStart.getHours() - intervalHours);
            reportTitle = `*Live Report for Current Hour* 📊`;
        }

        const currentStats = await this.getStatsForPeriod(user.trackedSymbols, reportPeriodStart, reportPeriodEnd);
        const previousStats = await this.getStatsForPeriod(user.trackedSymbols, previousPeriodStart, previousPeriodEnd);

        if (currentStats.size === 0) {
            return `No liquidations recorded for your tracked pairs in the current period.`;
        }
        const fundingMap = await this.marketDataService.getFundingMap(user.trackedSymbols);

        let longsReport = '';
        let shortsReport = '';
        let totalLongsValue = 0;
        let totalShortsValue = 0;

        for (const symbol of currentStats.keys()) {
            const current = currentStats.get(symbol)!;
            const previous = previousStats.get(symbol) || { longs: 0, shorts: 0 };
            
            const rate = fundingMap.get(symbol);
            const fundingStr = rate !== undefined ? ` | ⚡ ${(rate * 100).toFixed(4)}%` : '';

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
                longsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.longs)}${trend}${fundingStr}\n`;
                totalLongsValue += current.longs;
            }
            if (current.shorts > 0) {
                let trend = '';
                if (current.shorts > comparisonShorts) trend = ' ⬆️';
                else if (current.shorts < comparisonShorts) trend = ' ⬇️';
                shortsReport += `  ▪️ ${symbol}: $${this.formatCurrency(current.shorts)}${trend}${fundingStr}\n`;
                totalShortsValue += current.shorts;
            }
        }

        let finalReport = `${reportTitle}\n\n`;

        if (longsReport) {
            finalReport += `*🔴 LONGS LIQUIDATED*\n${longsReport}\n`;
        }
        if (shortsReport) {
            finalReport += `*🟢 SHORTS LIQUIDATED*\n${shortsReport}\n`;
        }
        
        finalReport += `*TOTAL:* 🔴 $${this.formatCurrency(totalLongsValue)} | 🟢 $${this.formatCurrency(totalShortsValue)}`;

        return finalReport;
    }
}