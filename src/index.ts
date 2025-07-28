// src/index.ts
import 'dotenv/config';

import { LiquidationListener } from './services/LiquidationListener';
import { DatabaseService } from './services/DatabaseService';
import { TelegramService } from './services/TelegramService';
import { ReportingService } from './services/ReportingService';
import { SYMBOLS_TO_TRACK } from './config';

function validateEnv() {
    const requiredEnvVars = [
        'FUTURES_WS_URL',
        'MONGO_DB_NAME',
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_CHAT_ID',
    ];

    if (process.env.NODE_ENV !== 'production') {
        requiredEnvVars.push('MONGO_URI');
    }

    const missingVars = requiredEnvVars.filter(v => !process.env[v]);

    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
}

async function main() {
    validateEnv();
    console.log('Application starting...');

    const mongoUri = process.env.MONGO_URI || process.env.MONGO_URI_LOCAL!;
    
    const dbService = new DatabaseService(mongoUri, process.env.MONGO_DB_NAME!);
    await dbService.connect();

    const listener = new LiquidationListener(
        SYMBOLS_TO_TRACK,
        dbService,
        process.env.FUTURES_WS_URL!
    );
    listener.start();

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID !== 'ЗАМЕНИ_НА_СВОЙ_CHAT_ID') {
        const telegramService = new TelegramService(process.env.TELEGRAM_BOT_TOKEN!);
        const reportingService = new ReportingService(
            dbService,
            telegramService,
            SYMBOLS_TO_TRACK,
            process.env.TELEGRAM_CHAT_ID!
        );
        reportingService.start();
    } else {
         console.warn('⚠️ Telegram bot token or chat ID is not configured. Reporting service is disabled.');
    }
}

main().catch(error => {
    console.error('An unexpected error occurred:', error);
    process.exit(1);
});