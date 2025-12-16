// src/index.ts
import 'dotenv/config';
import { RedisService } from './services/RedisService'; // New
import { LiquidationListener } from './services/LiquidationListener';
import { DatabaseService } from './services/DatabaseService';
import { TelegramService } from './services/TelegramService';
import { ReportingService } from './services/ReportingService';
import { MarketDataService } from './services/MarketDataService';
import { SYMBOLS_TO_TRACK } from './config';

async function main() {
    console.log('Application starting...');

    // 1. Init Database
    const dbService = new DatabaseService(process.env.MONGO_URI!, process.env.MONGO_DB_NAME!);
    await dbService.connect();

    // 2. Init Redis (Infrastructure)
    const redisService = new RedisService();

    // 3. Init Services
    const marketDataService = new MarketDataService(redisService);
    const reportingService = new ReportingService(dbService, marketDataService);
    
    const telegramService = new TelegramService(
        process.env.TELEGRAM_BOT_TOKEN!,
        dbService,
        reportingService,
        marketDataService
    );

    reportingService.setTelegramService(telegramService);

    // 4. Init Listener (With Cascade Logic inside)
    const listener = new LiquidationListener(
        SYMBOLS_TO_TRACK,
        dbService,
        telegramService,
        process.env.FUTURES_WS_URL!
    );

    listener.start();
    reportingService.start();

    console.log('✅ System Online: Redis + Cascades + Market Data active.');
}

main().catch(console.error);