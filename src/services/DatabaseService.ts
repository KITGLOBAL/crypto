// src/services/DatabaseService.ts

import { MongoClient, Db, WithId, MongoServerError, ObjectId } from 'mongodb';
import type { ActionableEntryZone, AnalysisSnapshot, SetupExpirationReason, SignalOutcome, TacticalSetup } from '../analysis/types';

export interface LiquidationData {
    symbol: string;
    side: 'short liquidation' | 'long liquidation';
    price: number;
    quantity: number;
    time: string;
    count?: number;
    isAggregate?: boolean;
    windowSeconds?: number;
    minPrice?: number;
    maxPrice?: number;
}

export interface User {
    chatId: number;
    firstName?: string;
    username?: string;
    trackedSymbols: string[];
    notificationsEnabled: boolean;
    reportIntervalHours: number;
    minLiquidationAlert: number;
    locale?: 'ru' | 'en';
    createdAt: Date;
}

export interface UserStats {
    totalUsers: number;
    activeUsers: number;
    minThreshold: number;
    maxThreshold: number;
    avgThreshold: number;
}

export interface LiquidationSummary {
    symbol: string;
    longs: number;
    shorts: number;
    orders: number;
}

export interface DominanceSnapshot {
    type: 'BTC.D' | 'USDT.D' | 'TOTAL';
    value: number;
    timestamp: Date;
}

export interface AnalysisSignalRecord {
    symbol: string;
    timeframe: string;
    decision: 'LONG' | 'SHORT' | 'WAIT';
    score: number;
    confidence: number;
    entryFrom?: number;
    entryTo?: number;
    stopLoss?: number;
    takeProfits?: number[];
    invalidation?: string;
    reasoning: string[];
    warnings: string[];
    rawAnalysis: object;
    signalOutcome?: SignalOutcome;
    strategyVersion: string;
    createdAt: Date;
}

export interface ActionableSetupRecord {
    setupId: string;
    symbol: string;
    timeframe: '4h';
    side: ActionableEntryZone['side'];
    from: number;
    to: number;
    source: ActionableEntryZone['source'];
    status: ActionableEntryZone['status'];
    createdAtCandleTime: string;
    currentPrice: number;
    requiredEntryForMinRr?: number;
    riskReward?: number;
    stopLoss?: number;
    target?: number;
    invalidation?: string;
    reason?: string;
    replacedBySetupId?: string;
    expiredReason?: SetupExpirationReason;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
}

export type ActionableSetupEventReason =
    | SetupExpirationReason
    | ActionableEntryZone['notTradableReason']
    | 'SETUP_CREATED'
    | 'STATUS_CHANGED'
    | 'SETUP_REPLACED';

export interface ActionableSetupEvent {
    setupId: string;
    symbol: string;
    timeframe: '4h';
    side: ActionableEntryZone['side'];
    status: ActionableEntryZone['status'];
    previousStatus?: ActionableEntryZone['status'];
    from: number;
    to: number;
    currentPrice: number;
    requiredEntryForMinRr?: number;
    riskReward?: number;
    tradable: boolean;
    reason?: ActionableSetupEventReason;
    source: ActionableEntryZone['source'];
    createdAt: Date;
}

export interface TacticalSetupEvent {
    symbol: string;
    timeframe: '1h';
    status: TacticalSetup['status'];
    previousStatus?: TacticalSetup['status'];
    side: TacticalSetup['side'];
    zoneFrom?: number;
    zoneTo?: number;
    zoneStatus?: TacticalSetup['zoneStatus'];
    rr?: number;
    stop?: number;
    requiredEntryForMinRr?: number;
    reason?: string;
    createdAt: Date;
}

export interface DashboardAlertSettings {
    id: 'global';
    mainDecisionChanges: boolean;
    actionableInZone: boolean;
    tacticalConfirmed: boolean;
    marketFilterConflict: boolean;
    minRiskReward: number;
    updatedAt: Date;
}

export class DatabaseService {
    private client: MongoClient;
    private dbName: string;
    private db!: Db;
    
    private readonly usersCollectionName = 'users';
    private readonly liquidationsCollectionName = 'liquidations';
    private readonly dominanceSnapshotsCollectionName = 'dominance_snapshots';
    private readonly analysisSignalsCollectionName = 'analysis_signals';
    private readonly analysisSnapshotsCollectionName = 'analysis_snapshots';
    private readonly actionableSetupsCollectionName = 'actionable_setups';
    private readonly actionableSetupEventsCollectionName = 'actionable_setup_events';
    private readonly tacticalSetupEventsCollectionName = 'tactical_setup_events';
    private readonly dashboardAlertSettingsCollectionName = 'dashboard_alert_settings';

    constructor(uri: string, dbName: string) {
        this.client = new MongoClient(uri);
        this.dbName = dbName;
    }

    public async connect(): Promise<void> {
        try {
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            console.log(`✅ Successfully connected to MongoDB. Database: ${this.dbName}`);

            console.log('Ensuring database indexes...');
            const usersCollection = this.db.collection(this.usersCollectionName);
            const liquidationsCollection = this.db.collection(this.liquidationsCollectionName);
            const dominanceCollection = this.db.collection(this.dominanceSnapshotsCollectionName);
            const analysisSignalsCollection = this.db.collection(this.analysisSignalsCollectionName);
            const analysisSnapshotsCollection = this.db.collection(this.analysisSnapshotsCollectionName);
            const actionableSetupsCollection = this.db.collection(this.actionableSetupsCollectionName);
            const actionableSetupEventsCollection = this.db.collection(this.actionableSetupEventsCollectionName);
            const tacticalSetupEventsCollection = this.db.collection(this.tacticalSetupEventsCollectionName);
            const dashboardAlertSettingsCollection = this.db.collection(this.dashboardAlertSettingsCollectionName);
            await usersCollection.createIndex({ chatId: 1 }, { unique: true });
            await usersCollection.createIndex({ notificationsEnabled: 1, trackedSymbols: 1 });
            await liquidationsCollection.createIndex({ symbol: 1, time: -1 });
            await liquidationsCollection.createIndex({ time: -1 });
            await dominanceCollection.createIndex({ type: 1, timestamp: -1 });
            await analysisSignalsCollection.createIndex({ symbol: 1, timeframe: 1, createdAt: -1 });
            await analysisSnapshotsCollection.createIndex({ symbol: 1, timeframe: 1, createdAt: -1 });
            await analysisSnapshotsCollection.createIndex({ createdAt: -1 });
            await actionableSetupsCollection.createIndex({ setupId: 1 }, { unique: true });
            await actionableSetupsCollection.createIndex({ symbol: 1, timeframe: 1, status: 1, updatedAt: -1 });
            await actionableSetupsCollection.createIndex({ expiresAt: 1 });
            await actionableSetupEventsCollection.createIndex({ setupId: 1, createdAt: -1 });
            await actionableSetupEventsCollection.createIndex({ symbol: 1, createdAt: -1 });
            await tacticalSetupEventsCollection.createIndex({ symbol: 1, createdAt: -1 });
            await tacticalSetupEventsCollection.createIndex({ status: 1, createdAt: -1 });
            await dashboardAlertSettingsCollection.createIndex({ id: 1 }, { unique: true });

            console.log('✅ Database indexes are in place.');

        } catch (error) {
            console.error('❌ Could not connect to MongoDB or create indexes.', error);
            process.exit(1);
        }
    }

    public async saveLiquidation(liquidation: LiquidationData): Promise<void> {
        const collection = this.db.collection(this.liquidationsCollectionName);
        try {
            await collection.insertOne(liquidation);
        } catch (error) {
            console.error(`[${liquidation.symbol}] Failed to save liquidation to database.`, error);
        }
    }

    public async close(): Promise<void> {
        await this.client.close();
        console.log('✅ MongoDB connection closed.');
    }
    
    public async getLiquidationsBetween(symbol: string, startTime: Date, endTime: Date): Promise<WithId<LiquidationData>[]> {
        const collection = this.db.collection<LiquidationData>(this.liquidationsCollectionName);
        return collection.find({
            symbol: symbol,
            time: {
                $gte: startTime.toISOString(),
                $lt: endTime.toISOString()
            }
        }).toArray();
    }

    public async getOverallLiquidationsBetween(startTime: Date, endTime: Date): Promise<WithId<LiquidationData>[]> {
        const collection = this.db.collection<LiquidationData>(this.liquidationsCollectionName);
        return collection.find({
            time: {
                $gte: startTime.toISOString(),
                $lt: endTime.toISOString()
            }
        }).toArray();
    }

    public async findOrCreateUser(chatId: number, firstName?: string, username?: string): Promise<User> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        const existingUser = await collection.findOne({ chatId });

        if (existingUser) {
            return existingUser;
        }

        const newUser: User = {
            chatId,
            firstName,
            username,
            trackedSymbols: [],
            notificationsEnabled: true,
            reportIntervalHours: 4,
            minLiquidationAlert: 10000,
            locale: 'ru',
            createdAt: new Date(),
        };

        try {
            await collection.insertOne(newUser);
            console.log(`✅ New user registered: ${firstName || 'anonymous'} (${chatId})`);
            return newUser;
        } catch (error) {
            if (error instanceof MongoServerError && error.code === 11000) {
                console.warn(`[${chatId}] Race condition detected. User already created. Fetching existing user.`);
                const user = await collection.findOne({ chatId });
                return user as User; 
            } else {
                throw error;
            }
        }
    }

    public async getUser(chatId: number): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        return collection.findOne({ chatId });
    }

    public async toggleSymbolForUser(chatId: number, symbol: string): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        const user = await collection.findOne({ chatId });
        if (!user) return null;

        const trackedSymbols = user.trackedSymbols || [];
        const symbolIndex = trackedSymbols.indexOf(symbol);

        if (symbolIndex > -1) {
            trackedSymbols.splice(symbolIndex, 1);
        } else {
            trackedSymbols.push(symbol);
        }
        
        await collection.updateOne({ chatId }, { $set: { trackedSymbols } });
        console.log(`[${chatId}] Toggled symbol ${symbol}. New list: [${trackedSymbols.join(', ')}]`);
        return { ...user, trackedSymbols };
    }

    public async setAllSymbolsForUser(chatId: number, symbols: string[]): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { trackedSymbols: symbols } });
        console.log(`[${chatId}] Set all symbols. New list length: ${symbols.length}`);
        const updatedUser = await this.getUser(chatId);
        return updatedUser;
    }

    public async toggleUserNotifications(chatId: number, forceState?: boolean): Promise<User | null> {
        const user = await this.getUser(chatId);
        if (!user) return null;
    
        const newStatus = typeof forceState === 'boolean' ? forceState : !user.notificationsEnabled;
        
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { notificationsEnabled: newStatus } });
        
        console.log(`[${chatId}] Set real-time notifications to: ${newStatus}.`);
        return { ...user, notificationsEnabled: newStatus };
    }

    public async updateUserReportInterval(chatId: number, intervalHours: number): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { reportIntervalHours: intervalHours } });
        const updatedUser = await this.getUser(chatId);
        console.log(`[${chatId}] Updated report interval to ${intervalHours} hours.`);
        return updatedUser;
    }
    
    public async updateUserAlertThreshold(chatId: number, threshold: number): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { minLiquidationAlert: threshold } });
        const updatedUser = await this.getUser(chatId);
        console.log(`[${chatId}] Updated alert threshold to $${threshold}.`);
        return updatedUser;
    }

    public async updateUserLocale(chatId: number, locale: 'ru' | 'en'): Promise<User | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { locale } });
        const updatedUser = await this.getUser(chatId);
        console.log(`[${chatId}] Updated locale to ${locale}.`);
        return updatedUser;
    }

    public async getActiveUsers(): Promise<User[]> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        return collection.find({
            notificationsEnabled: true,
            trackedSymbols: { $exists: true, $not: { $size: 0 } }
        }).toArray();
    }
    
    public async findUsersTrackingSymbol(symbol: string): Promise<User[]> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        return collection.find({
            notificationsEnabled: true,
            trackedSymbols: symbol
        }).toArray();
    }

    public async getUsersCount(): Promise<number> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        return collection.countDocuments();
    }

    public async getUserStats(): Promise<UserStats> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        const [totalUsers, activeUsers, thresholdStats] = await Promise.all([
            collection.countDocuments(),
            collection.countDocuments({
                notificationsEnabled: true,
                trackedSymbols: { $exists: true, $not: { $size: 0 } }
            }),
            collection.aggregate<{ minThreshold: number; maxThreshold: number; avgThreshold: number }>([
                {
                    $group: {
                        _id: null,
                        minThreshold: { $min: '$minLiquidationAlert' },
                        maxThreshold: { $max: '$minLiquidationAlert' },
                        avgThreshold: { $avg: '$minLiquidationAlert' }
                    }
                }
            ]).next()
        ]);

        return {
            totalUsers,
            activeUsers,
            minThreshold: thresholdStats?.minThreshold || 0,
            maxThreshold: thresholdStats?.maxThreshold || 0,
            avgThreshold: thresholdStats?.avgThreshold || 0
        };
    }

    public async getMinimumUserThresholdForSymbol(symbol: string): Promise<number | null> {
        const collection = this.db.collection<User>(this.usersCollectionName);
        const user = await collection.find({
            notificationsEnabled: true,
            trackedSymbols: symbol
        }).sort({ minLiquidationAlert: 1 }).limit(1).next();

        return user?.minLiquidationAlert ?? null;
    }

    public async getLastLiquidations(limit: number): Promise<WithId<LiquidationData>[]> {
        const collection = this.db.collection<LiquidationData>(this.liquidationsCollectionName);
        return collection.find({}).sort({ time: -1 }).limit(limit).toArray();
    }

    public async getLiquidationSummary(startTime: Date, endTime: Date, limit: number = 10): Promise<LiquidationSummary[]> {
        const collection = this.db.collection(this.liquidationsCollectionName);
        return collection.aggregate<LiquidationSummary>([
            {
                $match: {
                    time: {
                        $gte: startTime.toISOString(),
                        $lt: endTime.toISOString()
                    }
                }
            },
            {
                $project: {
                    symbol: 1,
                    side: 1,
                    volume: { $multiply: ['$price', '$quantity'] },
                    orders: { $ifNull: ['$count', 1] }
                }
            },
            {
                $group: {
                    _id: '$symbol',
                    longs: {
                        $sum: {
                            $cond: [{ $eq: ['$side', 'long liquidation'] }, '$volume', 0]
                        }
                    },
                    shorts: {
                        $sum: {
                            $cond: [{ $eq: ['$side', 'short liquidation'] }, '$volume', 0]
                        }
                    },
                    orders: { $sum: '$orders' }
                }
            },
            {
                $project: {
                    _id: 0,
                    symbol: '$_id',
                    longs: 1,
                    shorts: 1,
                    orders: 1,
                    total: { $add: ['$longs', '$shorts'] }
                }
            },
            { $sort: { total: -1 } },
            { $limit: limit }
        ]).toArray();
    }

    public async saveDominanceSnapshot(snapshot: { btcDominance: number; usdtDominance: number; totalMarketCapUsd: number; createdAt: string }): Promise<void> {
        const collection = this.db.collection<DominanceSnapshot>(this.dominanceSnapshotsCollectionName);
        const timestamp = new Date(snapshot.createdAt);
        await collection.insertMany([
            { type: 'BTC.D', value: snapshot.btcDominance, timestamp },
            { type: 'USDT.D', value: snapshot.usdtDominance, timestamp },
            { type: 'TOTAL', value: snapshot.totalMarketCapUsd, timestamp }
        ]);
    }

    public async getDominanceSnapshots(type: DominanceSnapshot['type'], limit: number): Promise<DominanceSnapshot[]> {
        const collection = this.db.collection<DominanceSnapshot>(this.dominanceSnapshotsCollectionName);
        const snapshots = await collection.find({ type }).sort({ timestamp: -1 }).limit(limit).toArray();
        return snapshots.reverse();
    }

    public async saveAnalysisSignal(signal: AnalysisSignalRecord): Promise<void> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        await collection.insertOne(signal);
    }

    public async saveAnalysisSnapshot(snapshot: AnalysisSnapshot): Promise<void> {
        const collection = this.db.collection<AnalysisSnapshot>(this.analysisSnapshotsCollectionName);
        await collection.insertOne(snapshot);
    }

    public async getActiveActionableSetup(symbol: string, timeframe: '4h'): Promise<WithId<ActionableSetupRecord> | null> {
        const collection = this.db.collection<ActionableSetupRecord>(this.actionableSetupsCollectionName);
        return collection.find({
            symbol,
            timeframe,
            status: { $nin: ['INVALIDATED', 'EXPIRED'] }
        }).sort({ updatedAt: -1 }).limit(1).next();
    }

    public async createActionableSetup(setup: ActionableSetupRecord): Promise<void> {
        const collection = this.db.collection<ActionableSetupRecord>(this.actionableSetupsCollectionName);
        await collection.updateOne(
            { setupId: setup.setupId },
            { $set: setup },
            { upsert: true }
        );
    }

    public async updateActionableSetup(setupId: string, patch: Partial<ActionableSetupRecord>): Promise<void> {
        const collection = this.db.collection<ActionableSetupRecord>(this.actionableSetupsCollectionName);
        await collection.updateOne(
            { setupId },
            { $set: { ...patch, updatedAt: patch.updatedAt || new Date() } }
        );
    }

    public async getAnalysisSnapshots(symbol: string, limit: number = 100): Promise<AnalysisSnapshot[]> {
        const collection = this.db.collection<AnalysisSnapshot>(this.analysisSnapshotsCollectionName);
        return collection.find({ symbol }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async getRecentAnalysisSnapshots(limit: number = 500): Promise<AnalysisSnapshot[]> {
        const collection = this.db.collection<AnalysisSnapshot>(this.analysisSnapshotsCollectionName);
        return collection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async getActionableSetups(limit: number = 100): Promise<WithId<ActionableSetupRecord>[]> {
        const collection = this.db.collection<ActionableSetupRecord>(this.actionableSetupsCollectionName);
        return collection.find({}).sort({ updatedAt: -1 }).limit(limit).toArray();
    }

    public async getActionableSetupById(setupId: string): Promise<WithId<ActionableSetupRecord> | null> {
        const collection = this.db.collection<ActionableSetupRecord>(this.actionableSetupsCollectionName);
        return collection.findOne({ setupId });
    }

    public async getAnalysisSnapshotsByActionableSetupId(setupId: string, limit: number = 200): Promise<AnalysisSnapshot[]> {
        const collection = this.db.collection<AnalysisSnapshot>(this.analysisSnapshotsCollectionName);
        return collection.find({ actionableEntryZoneSetupId: setupId }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async saveActionableSetupEvent(event: ActionableSetupEvent): Promise<void> {
        const collection = this.db.collection<ActionableSetupEvent>(this.actionableSetupEventsCollectionName);
        await collection.insertOne(event);
    }

    public async getLatestActionableSetupEvent(setupId: string): Promise<WithId<ActionableSetupEvent> | null> {
        const collection = this.db.collection<ActionableSetupEvent>(this.actionableSetupEventsCollectionName);
        return collection.find({ setupId }).sort({ createdAt: -1 }).limit(1).next();
    }

    public async getActionableSetupEvents(setupId: string, limit: number = 300): Promise<WithId<ActionableSetupEvent>[]> {
        const collection = this.db.collection<ActionableSetupEvent>(this.actionableSetupEventsCollectionName);
        return collection.find({ setupId }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async saveTacticalSetupEvent(event: TacticalSetupEvent): Promise<void> {
        const collection = this.db.collection<TacticalSetupEvent>(this.tacticalSetupEventsCollectionName);
        await collection.insertOne(event);
    }

    public async getLatestTacticalSetupEvent(symbol: string): Promise<WithId<TacticalSetupEvent> | null> {
        const collection = this.db.collection<TacticalSetupEvent>(this.tacticalSetupEventsCollectionName);
        return collection.find({ symbol }).sort({ createdAt: -1 }).limit(1).next();
    }

    public async getTacticalSetupEvents(symbol: string, limit: number = 300): Promise<WithId<TacticalSetupEvent>[]> {
        const collection = this.db.collection<TacticalSetupEvent>(this.tacticalSetupEventsCollectionName);
        return collection.find({ symbol }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async getTrackableAnalysisSignals(symbol: string, timeframe: string, limit: number = 20): Promise<WithId<AnalysisSignalRecord>[]> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        return collection.find({
            symbol,
            timeframe,
            decision: { $in: ['LONG', 'SHORT'] },
            $or: [
                { signalOutcome: { $exists: false } },
                { 'signalOutcome.status': 'OPEN' }
            ]
        }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async updateAnalysisSignalOutcome(id: ObjectId, outcome: SignalOutcome): Promise<void> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        await collection.updateOne({ _id: id }, {
            $set: {
                signalOutcome: outcome,
                'rawAnalysis.signalOutcome': outcome
            }
        });
    }

    public async getLastAnalysisSignal(symbol: string, timeframe: string): Promise<AnalysisSignalRecord | null> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        return collection.find({ symbol, timeframe }).sort({ createdAt: -1 }).limit(1).next();
    }

    public async getAnalysisSignalHistory(symbol: string, limit: number = 10): Promise<AnalysisSignalRecord[]> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        return collection.find({ symbol }).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async getRecentAnalysisSignals(limit: number = 500): Promise<AnalysisSignalRecord[]> {
        const collection = this.db.collection<AnalysisSignalRecord>(this.analysisSignalsCollectionName);
        return collection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    }

    public async getDashboardAlertSettings(): Promise<DashboardAlertSettings> {
        const collection = this.db.collection<DashboardAlertSettings>(this.dashboardAlertSettingsCollectionName);
        const existing = await collection.findOne({ id: 'global' });
        if (existing) return existing;

        const defaults: DashboardAlertSettings = {
            id: 'global',
            mainDecisionChanges: true,
            actionableInZone: true,
            tacticalConfirmed: true,
            marketFilterConflict: true,
            minRiskReward: 1.8,
            updatedAt: new Date()
        };
        await collection.updateOne({ id: 'global' }, { $setOnInsert: defaults }, { upsert: true });
        return defaults;
    }

    public async updateDashboardAlertSettings(patch: Partial<Omit<DashboardAlertSettings, 'id' | 'updatedAt'>>): Promise<DashboardAlertSettings> {
        const collection = this.db.collection<DashboardAlertSettings>(this.dashboardAlertSettingsCollectionName);
        const allowedPatch: Partial<Omit<DashboardAlertSettings, 'id' | 'updatedAt'>> = {};
        if (typeof patch.mainDecisionChanges === 'boolean') allowedPatch.mainDecisionChanges = patch.mainDecisionChanges;
        if (typeof patch.actionableInZone === 'boolean') allowedPatch.actionableInZone = patch.actionableInZone;
        if (typeof patch.tacticalConfirmed === 'boolean') allowedPatch.tacticalConfirmed = patch.tacticalConfirmed;
        if (typeof patch.marketFilterConflict === 'boolean') allowedPatch.marketFilterConflict = patch.marketFilterConflict;
        if (typeof patch.minRiskReward === 'number' && patch.minRiskReward >= 1 && patch.minRiskReward <= 5) {
            allowedPatch.minRiskReward = patch.minRiskReward;
        }

        const defaults = await this.getDashboardAlertSettings();
        await collection.updateOne(
            { id: 'global' },
            { $set: { ...defaults, ...allowedPatch, id: 'global', updatedAt: new Date() } },
            { upsert: true }
        );
        return this.getDashboardAlertSettings();
    }
    
    public async deleteOldLiquidations(olderThan: Date): Promise<number> {
        const collection = this.db.collection(this.liquidationsCollectionName);
        try {
            const result = await collection.deleteMany({
                time: { $lt: olderThan.toISOString() }
            });
            console.log(`🧹 Successfully deleted ${result.deletedCount} old liquidation records.`);
            return result.deletedCount;
        } catch (error) {
            console.error(`Failed to delete old liquidations.`, error);
            return 0;
        }
    }
}
