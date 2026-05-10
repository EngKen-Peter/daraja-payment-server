require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment variables
const config = {
    baseUrl: process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    passkey: process.env.MPESA_PASSKEY,
    shortcode: process.env.MPESA_BUSINESS_SHORTCODE,
    environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
};

console.log('=== M-Pesa Daraja Server Configuration ===');
console.log(`Environment: ${config.environment}`);
console.log(`Base URL: ${config.baseUrl}`);
console.log(`Shortcode: ${config.shortcode}`);
console.log('===========================================');

// In-memory token storage (in production, use Redis or database)
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
        // Set expiry to 1 hour (3599 seconds) from now
        tokenExpiry = Date.now() + (parseInt(response.data.expires_in) * 1000);
        
        console.log('✅ Generated new M-Pesa access token');
        console.log(`   Token expires at: ${new Date(tokenExpiry).toISOString()}`);
        
        return accessToken;
    } catch (error) {
        console.error('❌ Token generation failed:', error.response?.data || error.message);
        throw error;
    }
}

// Get valid access token (generates new if expired)
async function getValidToken() {
    if (!accessToken || Date.now() >= tokenExpiry) {
        await generateAccessToken();
    }
    return accessToken;
}

// Register C2B URLs with Safaricom
async function registerUrls() {
    try {
        const token = await getValidToken();
        const url = `${config.baseUrl}/mpesa/c2b/v1/registerurl`;
        
        const payload = {
            ShortCode: config.shortcode,
            ResponseType: 'Completed',
            ConfirmationURL: `https://daraja-payment-server.onrender.com/mpesa/confirmation`,
            ValidationURL: `https://daraja-payment-server.onrender.com/mpesa/validation`
        };
        
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log('✅ C2B URLs registered successfully');
        console.log('   Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ URL registration failed:', error.response?.data || error.message);
        throw error;
    }
}

// Simulate C2B payment (Sandbox only)
async function simulatePayment(phoneNumber, amount, billRefNumber = 'Test001') {
    try {
        const token = await getValidToken();
        const url = `${config.baseUrl}/mpesa/c2b/v1/simulate`;
        
        const payload = {
            ShortCode: config.shortcode,
            CommandID: 'CustomerPayBillOnline',
            Amount: amount,
            Msisdn: phoneNumber,
            BillRefNumber: billRefNumber
        };
        
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`✅ Payment simulation successful: ${amount} KES from ${phoneNumber}`);
        return response.data;
    } catch (error) {
        console.error('❌ Payment simulation failed:', error.response?.data || error.message);
        throw error;
    }
}

// Query account balance
async function queryBalance() {
    try {
        const token = await getValidToken();
        const url = `${config.baseUrl}/mpesa/accountbalance/v1/query`;
        
        // Note: For production, you need proper security credential encryption
        const payload = {
            Initiator: 'testapi',
            SecurityCredential: 'ENCRYPTED_PASSWORD', // Requires encryption
            CommandID: 'AccountBalance',
            PartyA: config.shortcode,
            IdentifierType: '4',
            Remarks: 'Balance Query',
            QueueTimeOutURL: 'https://daraja-payment-server.onrender.com/timeout',
            ResultURL: 'https://daraja-payment-server.onrender.com/result'
        };
        
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log('✅ Balance query successful');
        return response.data;
    } catch (error) {
        console.error('❌ Balance query failed:', error.response?.data || error.message);
        throw error;
    }
}

// ==================== ENDPOINTS ====================

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        environment: config.environment,
        shortcode: config.shortcode,
        message: 'M-Pesa Daraja Server is running successfully',
        timestamp: new Date().toISOString()
    });
});

// Confirmation URL endpoint (Called by Safaricom after successful payment)
app.post('/mpesa/confirmation', async (req, res) => {
    try {
        console.log('=========================================');
        console.log('💰 PAYMENT CONFIRMATION RECEIVED');
        console.log('=========================================');
        console.log('Transaction Data:', JSON.stringify(req.body, null, 2));
        
        const transaction = req.body;
        
        // Log important transaction details
        console.log(`📋 Transaction ID: ${transaction.TransID}`);
        console.log(`💰 Amount: ${transaction.TransAmount} KES`);
        console.log(`📱 Phone: ${transaction.MSISDN}`);
        console.log(`🕐 Time: ${transaction.TransTime}`);
        console.log(`🏦 Bill Ref: ${transaction.BillRefNumber}`);
        console.log(`📝 Transaction Type: ${transaction.TransactionType}`);
        
        // TODO: Save transaction to database
        // TODO: Update order/invoice status
        
        console.log('=========================================');
        
        // Respond to Safaricom
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

// Validation URL endpoint (Called by Safaricom before payment)
app.post('/mpesa/validation', async (req, res) => {
    try {
        console.log('=========================================');
        console.log('🔍 PAYMENT VALIDATION RECEIVED');
        console.log('=========================================');
        console.log('Validation Data:', JSON.stringify(req.body, null, 2));
        
        const validation = req.body;
        
        // TODO: Validate transaction
        // Check if bill reference is valid
        // Check if amount is within limits
        // Check if customer exists
        
        console.log(`📱 Validating payment from ${validation.MSISDN}`);
        console.log(`💰 Amount: ${validation.TransAmount}`);
        console.log(`🏦 Bill Ref: ${validation.BillRefNumber}`);
        
        console.log('=========================================');
        
        // Always return success to accept transaction
        // To reject: ResultCode: 1, ResultDesc: 'Rejected'
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

// Generate token endpoint (for testing)
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

// Register URLs endpoint (for testing)
app.post('/api/register-urls', async (req, res) => {
    try {
        const result = await registerUrls();
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Simulate payment endpoint (Sandbox only)
app.post('/api/simulate-payment', async (req, res) => {
    try {
        const { phoneNumber, amount, billRefNumber } = req.body;
        
        if (!phoneNumber || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Phone number and amount are required'
            });
        }
        
        // Validate phone number format
        const formattedPhone = phoneNumber.startsWith('254') ? phoneNumber : `254${phoneNumber.slice(-9)}`;
        
        const result = await simulatePayment(formattedPhone, amount, billRefNumber);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Query balance endpoint
app.get('/api/balance', async (req, res) => {
    try {
        const result = await queryBalance();
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Status endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        environment: config.environment,
        shortcode: config.shortcode,
        token_valid: accessToken && Date.now() < tokenExpiry,
        token_expires_at: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Start server and generate initial token
app.listen(port, async () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📍 URL: https://daraja-payment-server.onrender.com`);
    
    // Generate initial access token
    try {
        await generateAccessToken();
        console.log('🎉 Server ready to process M-Pesa payments!');
        
        // Auto-register URLs on startup (optional)
        if (config.environment === 'production') {
            console.log('📝 Attempting to register callback URLs...');
            await registerUrls();
        }
    } catch (error) {
        console.error('⚠️ Initialization warning:', error.message);
    }
});