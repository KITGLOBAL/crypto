// src/index.ts
import 'dotenv/config';
import { RedisService } from './services/RedisService'; // New
import { LiquidationListener } from './services/LiquidationListener';
import { DatabaseService } from './services/DatabaseService';
import { TelegramService } from './services/TelegramService';
import { ReportingService } from './services/ReportingService';
import { MarketDataService } from './services/MarketDataService';
import { AnalysisService } from './analysis/AnalysisService';
import { AnalysisSnapshotService } from './services/AnalysisSnapshotService';
import { CHANNEL_MIN_LIQUIDATION, SYMBOLS_TO_TRACK } from './config';
import { ApiService } from './api/ApiService';

async function main() {
    console.log('Application starting...');
    const startedAt = Date.now();

    // 1. Init Database
    const dbService = new DatabaseService(process.env.MONGO_URI!, process.env.MONGO_DB_NAME!);
    await dbService.connect();

    // 2. Init Redis (Infrastructure)
    const redisService = new RedisService();

    // 3. Init Services
    const marketDataService = new MarketDataService(redisService);
    const reportingService = new ReportingService(dbService, marketDataService);
    const analysisService = new AnalysisService(dbService, redisService, marketDataService);
    const analysisSnapshotService = new AnalysisSnapshotService(analysisService);
    const apiService = new ApiService(dbService, analysisService);
    
    const telegramService = new TelegramService(
        process.env.TELEGRAM_BOT_TOKEN!,
        dbService,
        reportingService,
        marketDataService,
        analysisService
    );

    reportingService.setTelegramService(telegramService);

    // 4. Init Listener (With Cascade Logic inside)
    const listener = new LiquidationListener(
        SYMBOLS_TO_TRACK,
        dbService,
        telegramService,
        process.env.FUTURES_WS_URL!
    );

    telegramService.setStatusProvider(async () => ({
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        listener: listener.getStatus(),
        db: {
            users: await dbService.getUserStats(),
            lastLiquidations: await dbService.getLastLiquidations(5)
        },
        thresholds: {
            channelMinLiquidation: CHANNEL_MIN_LIQUIDATION
        }
    }));

    listener.start();
    reportingService.start();
    analysisSnapshotService.start();
    apiService.start();

    console.log('✅ System Online: Redis + Cascades + Market Data + Analysis Snapshots active.');

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${signal} received. Shutting down gracefully...`);

        try {
            reportingService.stop();
            analysisSnapshotService.stop();
            await apiService.stop();
            await listener.stop();
            await telegramService.stop();
            await redisService.close();
            await dbService.close();
            console.log('✅ Graceful shutdown completed.');
            process.exit(0);
        } catch (error) {
            console.error('❌ Graceful shutdown failed:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch(error => {
    console.error('Fatal startup error:', error);
    process.exit(1);
});
