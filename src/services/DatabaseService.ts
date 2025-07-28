// src/services/DatabaseService.ts

import { MongoClient, Db, WithId, MongoServerError } from 'mongodb';

export interface LiquidationData {
    symbol: string;
    side: 'short liquidation' | 'long liquidation';
    price: number;
    quantity: number;
    time: string;
}

export interface User {
    chatId: number;
    firstName?: string;
    username?: string;
    trackedSymbols: string[];
    notificationsEnabled: boolean;
    reportIntervalHours: number;
    minLiquidationAlert: number;
    createdAt: Date;
}

export class DatabaseService {
    private client: MongoClient;
    private dbName: string;
    private db!: Db;
    
    private readonly usersCollectionName = 'users';
    private readonly liquidationsCollectionName = 'liquidations';

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
            await usersCollection.createIndex({ chatId: 1 }, { unique: true });
            await liquidationsCollection.createIndex({ symbol: 1, time: -1 });

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

    public async toggleUserNotifications(chatId: number): Promise<User | null> {
        const user = await this.getUser(chatId);
        if (!user) return null;
    
        const newStatus = !user.notificationsEnabled;
        const collection = this.db.collection<User>(this.usersCollectionName);
        await collection.updateOne({ chatId }, { $set: { notificationsEnabled: newStatus } });
        
        console.log(`[${chatId}] Toggled real-time notifications to: ${newStatus}.`);
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