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
        'MONGO_URI'
    ];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
}
async function main() {
    validateEnv();
    console.log('Application starting...');

    const dbService = new DatabaseService(process.env.MONGO_URI!, process.env.MONGO_DB_NAME!);
    await dbService.connect();

    const telegramService = new TelegramService(
        process.env.TELEGRAM_BOT_TOKEN!, 
        dbService
    );
    
    const listener = new LiquidationListener(
        SYMBOLS_TO_TRACK,
        dbService,
        telegramService,
        process.env.FUTURES_WS_URL!
    );
    listener.start();
    
    const reportingService = new ReportingService(dbService, telegramService);
    reportingService.start();

    console.log('✅ Application successfully started and all services are running.');
}

main().catch(error => {
    console.error('An unexpected error occurred in main:', error);
    process.exit(1);
});