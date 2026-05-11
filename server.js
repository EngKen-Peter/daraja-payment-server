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
    baseUrl: process.env.MPESA_BASE_URL || 'https://api.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    passkey: process.env.MPESA_PASSKEY,
    shortcode: process.env.MPESA_BUSINESS_SHORTCODE || '4561807',  // Updated to child store number
    environment: process.env.MPESA_ENVIRONMENT || 'production'
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
// IMPORTANT: URL does NOT contain "mpesa" - Safaricom blocks URLs with that word
app.post('/api/c2b/confirmation', async (req, res) => {
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
app.post('/api/c2b/validation', async (req, res) => {
    try {
        console.log('=========================================');
        console.log('🔍 PAYMENT VALIDATION RECEIVED');
        console.log('=========================================');
        console.log('Validation Data:', JSON.stringify(req.body, null, 2));
        
        const validation = req.body;
        
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

// Server status endpoint
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
    console.log(`📍 URL: https://daraja-payment-server-1.onrender.com`);
    
    // Generate initial access token
    try {
        await generateAccessToken();
        console.log('🎉 Server ready to process M-Pesa payments!');
    } catch (error) {
        console.error('⚠️ Initialization warning:', error.message);
    }
});