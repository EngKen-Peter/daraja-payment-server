require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { Pool } = require('pg');  // ADDED: PostgreSQL database

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment variables
const config = {
    baseUrl: process.env.MPESA_BASE_URL || 'https://api.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    passkey: process.env.MPESA_PASSKEY,
    shortcode: process.env.MPESA_BUSINESS_SHORTCODE || '4561807',
    environment: process.env.MPESA_ENVIRONMENT || 'production'
};

// ADDED: PostgreSQL Database Configuration
const dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }  // Required for Render PostgreSQL
};

let dbPool = null;

// ADDED: Initialize Database Connection
function initDatabase() {
    try {
        dbPool = new Pool(dbConfig);
        console.log('✅ Database connected successfully');
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

// ADDED: Create tables if they don't exist
async function createTables() {
    if (!dbPool) return;
    
    try {
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                transaction_id VARCHAR(50) UNIQUE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                phone_number VARCHAR(255),
                customer_name VARCHAR(100),
                bill_ref_number VARCHAR(100),
                transaction_time VARCHAR(20),
                transaction_type VARCHAR(50),
                business_shortcode VARCHAR(20),
                raw_data JSONB,
                processed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await dbPool.query(`
            CREATE INDEX IF NOT EXISTS idx_transaction_id ON transactions(transaction_id);
            CREATE INDEX IF NOT EXISTS idx_created_at ON transactions(created_at);
            CREATE INDEX IF NOT EXISTS idx_phone_number ON transactions(phone_number);
        `);
        
        console.log('✅ Database tables created/verified');
    } catch (error) {
        console.error('❌ Failed to create tables:', error.message);
    }
}

// ADDED: Save transaction to database
async function saveTransaction(transaction) {
    if (!dbPool) {
        console.error('❌ Database not connected - cannot save transaction');
        return false;
    }
    
    try {
        const query = `
            INSERT INTO transactions 
            (transaction_id, amount, phone_number, customer_name, bill_ref_number, 
             transaction_time, transaction_type, business_shortcode, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (transaction_id) DO UPDATE SET
                amount = EXCLUDED.amount,
                customer_name = EXCLUDED.customer_name,
                raw_data = EXCLUDED.raw_data
            RETURNING id
        `;
        
        const values = [
            transaction.TransID,
            parseFloat(transaction.TransAmount),
            transaction.MSISDN,
            transaction.FirstName || null,
            transaction.BillRefNumber || '',
            transaction.TransTime,
            transaction.TransactionType || 'Customer Merchant Payment',
            transaction.BusinessShortCode || config.shortcode,
            JSON.stringify(transaction)
        ];
        
        const result = await dbPool.query(query, values);
        console.log(`💾 Transaction ${transaction.TransID} saved to database (ID: ${result.rows[0].id})`);
        return true;
    } catch (error) {
        console.error('❌ Failed to save transaction:', error.message);
        return false;
    }
}

// ADDED: Get transactions from database
async function getTransactions(limit = 50, offset = 0) {
    if (!dbPool) return [];
    
    try {
        const query = `
            SELECT id, transaction_id, amount, phone_number, customer_name, 
                   bill_ref_number, transaction_time, transaction_type, 
                   processed, created_at
            FROM transactions 
            ORDER BY created_at DESC 
            LIMIT $1 OFFSET $2
        `;
        const result = await dbPool.query(query, [limit, offset]);
        return result.rows;
    } catch (error) {
        console.error('❌ Failed to get transactions:', error.message);
        return [];
    }
}

// ADDED: Get transaction by ID
async function getTransactionById(transactionId) {
    if (!dbPool) return null;
    
    try {
        const query = `SELECT * FROM transactions WHERE transaction_id = $1`;
        const result = await dbPool.query(query, [transactionId]);
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Failed to get transaction:', error.message);
        return null;
    }
}

// ADDED: Get daily sales summary
async function getDailySalesSummary() {
    if (!dbPool) return [];
    
    try {
        const query = `
            SELECT 
                DATE(created_at) as sale_date,
                COUNT(*) as transaction_count,
                SUM(amount) as total_amount,
                COUNT(DISTINCT phone_number) as unique_customers
            FROM transactions 
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY sale_date DESC
        `;
        const result = await dbPool.query(query);
        return result.rows;
    } catch (error) {
        console.error('❌ Failed to get daily summary:', error.message);
        return [];
    }
}

// MQTT Configuration
const mqttConfig = {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtts://ef6a77de243f47bcad53fd8d6c2cad46.s1.eu.hivemq.cloud:8883',
    username: process.env.MQTT_USERNAME || 'coffee_dispenser',
    password: process.env.MQTT_PASSWORD || 'Smartcoffeedispenser@Saf001',
    topic: process.env.MQTT_TOPIC || 'coffee/dispense'
};

let mqttClient = null;

// Connect to HiveMQ MQTT Broker
function connectMQTT() {
    try {
        console.log('🔌 Connecting to HiveMQ Cloud MQTT broker...');
        
        mqttClient = mqtt.connect(mqttConfig.brokerUrl, {
            username: mqttConfig.username,
            password: mqttConfig.password,
            rejectUnauthorized: true,
            keepalive: 60,
            reconnectPeriod: 5000
        });

        mqttClient.on('connect', () => {
            console.log('✅ Connected to HiveMQ Cloud MQTT broker');
            console.log(`   Topic: ${mqttConfig.topic}`);
        });

        mqttClient.on('error', (error) => {
            console.error('❌ MQTT connection error:', error.message);
        });

        mqttClient.on('reconnect', () => {
            console.log('🔄 MQTT reconnecting...');
        });

        mqttClient.on('offline', () => {
            console.log('⚠️ MQTT client is offline');
        });
    } catch (error) {
        console.error('❌ Failed to connect to MQTT:', error.message);
    }
}

// Publish message to MQTT topic
function publishToMQTT(transaction) {
    if (!mqttClient || !mqttClient.connected) {
        console.error('❌ MQTT not connected - cannot send dispense command');
        return false;
    }
    
    try {
        const message = {
            transaction_id: transaction.TransID,
            amount: transaction.TransAmount,
            phone: transaction.MSISDN,
            first_name: transaction.FirstName || '',
            bill_ref: transaction.BillRefNumber || '',
            transaction_time: transaction.TransTime,
            timestamp: new Date().toISOString(),
            action: 'dispense_coffee'
        };
        
        mqttClient.publish(mqttConfig.topic, JSON.stringify(message), { qos: 1, retain: false }, (error) => {
            if (error) {
                console.error('❌ Failed to send MQTT message:', error.message);
            } else {
                console.log(`✅ Dispense command sent to Raspberry Pi`);
                console.log(`   Topic: ${mqttConfig.topic}`);
                console.log(`   Transaction: ${transaction.TransID}`);
                console.log(`   Amount: ${transaction.TransAmount} KES`);
                console.log(`   Customer: ${transaction.FirstName || 'Unknown'}`);
            }
        });
        return true;
    } catch (error) {
        console.error('❌ MQTT publish error:', error.message);
        return false;
    }
}

console.log('=== M-Pesa Daraja Server Configuration ===');
console.log(`Environment: ${config.environment}`);
console.log(`Base URL: ${config.baseUrl}`);
console.log(`Shortcode: ${config.shortcode}`);
console.log(`MQTT Topic: ${mqttConfig.topic}`);
console.log('===========================================');

// Initialize Database
initDatabase();

// Create tables after database connection
setTimeout(() => {
    if (dbPool) {
        createTables();
    }
}, 2000);

// Connect to MQTT broker on startup
connectMQTT();

// In-memory token storage
let accessToken = null;
let tokenExpiry = null;

// Generate OAuth Access Token
async function generateAccessToken() {
    try {
        const url = `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
        const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
        
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });
        
        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (parseInt(response.data.expires_in) * 1000);
        
        console.log('✅ Generated new M-Pesa access token');
        console.log(`   Token expires at: ${new Date(tokenExpiry).toISOString()}`);
        
        return accessToken;
    } catch (error) {
        console.error('❌ Token generation failed:', error.response?.data || error.message);
        throw error;
    }
}

// Get valid access token
async function getValidToken() {
    if (!accessToken || Date.now() >= tokenExpiry) {
        await generateAccessToken();
    }
    return accessToken;
}

// ==================== ENDPOINTS ====================

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        environment: config.environment,
        shortcode: config.shortcode,
        mqtt_connected: mqttClient ? mqttClient.connected : false,
        database_connected: dbPool ? true : false,
        message: 'M-Pesa Daraja Server is running successfully',
        timestamp: new Date().toISOString()
    });
});

// Confirmation URL endpoint (Called by Safaricom after successful payment)
app.post('/api/c2b/confirmation', async (req, res) => {
    try {
        console.log('=========================================');
        console.log('💰 PAYMENT CONFIRMATION RECEIVED');
        console.log('=========================================');
        console.log('Transaction Data:', JSON.stringify(req.body, null, 2));
        
        const transaction = req.body;
        
        console.log(`📋 Transaction ID: ${transaction.TransID}`);
        console.log(`💰 Amount: ${transaction.TransAmount} KES`);
        console.log(`📱 Phone: ${transaction.MSISDN}`);
        console.log(`👤 Customer: ${transaction.FirstName || 'Unknown'}`);
        console.log(`🕐 Time: ${transaction.TransTime}`);
        
        // Save to database
        await saveTransaction(transaction);
        
        // Send MQTT message to Raspberry Pi
        console.log('📡 Sending dispense command via MQTT...');
        publishToMQTT(transaction);
        
        console.log('=========================================');
        
        res.status(200).json({
            ResultCode: 0,
            ResultDesc: 'Success'
        });
    } catch (error) {
        console.error('❌ Error processing confirmation:', error);
        res.status(500).json({
            ResultCode: 1,
            ResultDesc: 'Internal Server Error'
        });
    }
});

// Validation URL endpoint
app.post('/api/c2b/validation', async (req, res) => {
    try {
        console.log('=========================================');
        console.log('🔍 PAYMENT VALIDATION RECEIVED');
        console.log('=========================================');
        console.log('Validation Data:', JSON.stringify(req.body, null, 2));
        
        res.status(200).json({
            ResultCode: 0,
            ResultDesc: 'Success'
        });
    } catch (error) {
        console.error('❌ Error in validation:', error);
        res.status(200).json({
            ResultCode: 1,
            ResultDesc: 'Validation failed'
        });
    }
});

// Generate token endpoint
app.get('/api/token', async (req, res) => {
    try {
        const token = await getValidToken();
        res.json({
            success: true,
            access_token: token,
            expires_at: new Date(tokenExpiry).toISOString(),
            environment: config.environment
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Server status endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        environment: config.environment,
        shortcode: config.shortcode,
        token_valid: accessToken && Date.now() < tokenExpiry,
        token_expires_at: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
        mqtt_connected: mqttClient ? mqttClient.connected : false,
        database_connected: dbPool ? true : false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ==================== DATABASE API ENDPOINTS ====================

// Get recent transactions
app.get('/api/transactions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const transactions = await getTransactions(limit, offset);
        res.json({
            success: true,
            count: transactions.length,
            transactions: transactions
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get transaction by ID
app.get('/api/transactions/:id', async (req, res) => {
    try {
        const transaction = await getTransactionById(req.params.id);
        if (transaction) {
            res.json({ success: true, transaction });
        } else {
            res.status(404).json({ success: false, error: 'Transaction not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get daily sales summary
app.get('/api/sales/summary', async (req, res) => {
    try {
        const summary = await getDailySalesSummary();
        
        let totalResult = { rows: [{ total_transactions: 0, total_revenue: 0 }] };
        if (dbPool) {
            totalResult = await dbPool.query(`
                SELECT 
                    COUNT(*) as total_transactions,
                    SUM(amount) as total_revenue
                FROM transactions
            `);
        }
        
        res.json({
            success: true,
            daily_summary: summary,
            totals: totalResult.rows[0] || { total_transactions: 0, total_revenue: 0 }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test MQTT endpoint
app.post('/api/test/mqtt', async (req, res) => {
    try {
        const { transaction_id, amount, phone, first_name } = req.body;
        const testTransaction = {
            TransID: transaction_id || 'TEST_12345',
            TransAmount: amount || '10.00',
            MSISDN: phone || '254712345678',
            FirstName: first_name || 'Test Customer',
            TransTime: new Date().toISOString(),
            BillRefNumber: '',
            TransactionType: 'Customer Merchant Payment'
        };
        
        publishToMQTT(testTransaction);
        res.json({ success: true, message: 'Test MQTT message sent' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== KEEP-ALIVE ENDPOINTS ====================

app.get('/keep-alive', (req, res) => {
    res.status(200).send('OK');
    console.log(`💓 Keep-alive ping received at ${new Date().toISOString()}`);
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// ==================== START SERVER ====================

app.listen(port, async () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📍 URL: https://daraja-payment-server-1.onrender.com`);
    console.log(`💓 Keep-alive endpoints: /keep-alive and /ping`);
    console.log(`📊 Database endpoints: /api/transactions, /api/sales/summary`);
    
    try {
        await generateAccessToken();
        console.log('🎉 Server ready to process M-Pesa payments!');
    } catch (error) {
        console.error('⚠️ Initialization warning:', error.message);
    }
});
