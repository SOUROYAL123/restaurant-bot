#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════
 * SECURITY TEST SUITE
 * Automated security verification
 * Usage: node test-security.js
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'http://localhost:10000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// ANSI colors
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function log(level, message) {
    const timestamp = new Date().toISOString();
    const levelColors = {
        PASS: colors.green,
        FAIL: colors.red,
        WARN: colors.yellow,
        INFO: colors.cyan
    };
    console.log(`${levelColors[level]}[${level}]${colors.reset} ${message}`);
}

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const req = protocol.request(urlObj, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });
        
        req.on('error', reject);
        
        if (options.body) {
            req.write(options.body);
        }
        
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════

async function runTests() {
    console.log('\n' + colors.bold + '═══════════════════════════════════════════════════════════');
    console.log('🔒 SECURITY TEST SUITE');
    console.log('═══════════════════════════════════════════════════════════' + colors.reset + '\n');
    
    let passed = 0;
    let failed = 0;
    let warnings = 0;
    
    // ═══════════════════════════════════════════════════════════
    // Test 1: Health Check (Public)
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 1: Health check endpoint...');
        const res = await makeRequest(`${BASE_URL}/health`, { method: 'GET' });
        
        if (res.statusCode === 200) {
            const data = JSON.parse(res.body);
            if (data.status === 'healthy' && data.database === 'connected') {
                log('PASS', '✓ Health check passed');
                passed++;
            } else {
                log('WARN', '⚠ Health check returned degraded status');
                warnings++;
            }
        } else {
            log('FAIL', `✗ Health check failed (status: ${res.statusCode})`);
            failed++;
        }
    } catch (error) {
        log('FAIL', `✗ Health check error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 2: Security Headers
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 2: Security headers...');
        const res = await makeRequest(`${BASE_URL}/`, { method: 'GET' });
        
        const requiredHeaders = [
            'x-frame-options',
            'x-content-type-options',
            'x-xss-protection'
        ];
        
        let headersPresent = true;
        requiredHeaders.forEach(header => {
            if (!res.headers[header]) {
                log('FAIL', `✗ Missing header: ${header}`);
                headersPresent = false;
            }
        });
        
        if (headersPresent) {
            log('PASS', '✓ All security headers present');
            passed++;
        } else {
            failed++;
        }
    } catch (error) {
        log('FAIL', `✗ Security headers test error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 3: Admin Endpoint Protection
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 3: Admin endpoint protection...');
        
        // Test without API key
        const res1 = await makeRequest(`${BASE_URL}/status`, { method: 'GET' });
        
        if (res1.statusCode === 401) {
            log('PASS', '✓ Admin endpoint blocked without API key');
            passed++;
        } else {
            log('FAIL', `✗ Admin endpoint accessible without API key (status: ${res1.statusCode})`);
            failed++;
        }
        
        // Test with API key (if configured)
        if (ADMIN_API_KEY) {
            const res2 = await makeRequest(`${BASE_URL}/status`, {
                method: 'GET',
                headers: { 'X-API-Key': ADMIN_API_KEY }
            });
            
            if (res2.statusCode === 200) {
                log('PASS', '✓ Admin endpoint accessible with valid API key');
                passed++;
            } else {
                log('FAIL', `✗ Admin endpoint not accessible with API key (status: ${res2.statusCode})`);
                failed++;
            }
        } else {
            log('WARN', '⚠ ADMIN_API_KEY not set, skipping authenticated test');
            warnings++;
        }
    } catch (error) {
        log('FAIL', `✗ Admin protection test error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 4: Rate Limiting
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 4: Rate limiting (sending 101 requests)...');
        
        let rateLimitHit = false;
        for (let i = 0; i < 101; i++) {
            const res = await makeRequest(`${BASE_URL}/ping`, { method: 'GET' });
            if (res.statusCode === 429) {
                rateLimitHit = true;
                break;
            }
        }
        
        if (rateLimitHit) {
            log('PASS', '✓ Rate limiting active');
            passed++;
        } else {
            log('WARN', '⚠ Rate limiting may not be active (no 429 response)');
            warnings++;
        }
    } catch (error) {
        log('FAIL', `✗ Rate limiting test error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 5: Invalid Payment Callback
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 5: Invalid payment callback rejection...');
        
        const res = await makeRequest(`${BASE_URL}/payment-callback?invalid=true`, { 
            method: 'GET' 
        });
        
        if (res.statusCode === 400) {
            log('PASS', '✓ Invalid payment callback rejected');
            passed++;
        } else {
            log('FAIL', `✗ Invalid payment callback not rejected (status: ${res.statusCode})`);
            failed++;
        }
    } catch (error) {
        log('FAIL', `✗ Payment callback test error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 6: HTTPS Enforcement (Production only)
    // ═══════════════════════════════════════════════════════════
    if (process.env.NODE_ENV === 'production') {
        try {
            log('INFO', 'Test 6: HTTPS enforcement...');
            
            if (BASE_URL.startsWith('https://')) {
                log('PASS', '✓ HTTPS is enforced');
                passed++;
            } else {
                log('FAIL', '✗ HTTPS not enforced in production!');
                failed++;
            }
        } catch (error) {
            log('FAIL', `✗ HTTPS test error: ${error.message}`);
            failed++;
        }
    } else {
        log('INFO', 'Test 6: HTTPS enforcement (skipped - not production)');
    }
    
    // ═══════════════════════════════════════════════════════════
    // Test 7: Environment Variables
    // ═══════════════════════════════════════════════════════════
    try {
        log('INFO', 'Test 7: Critical environment variables...');
        
        const required = [
            'DATABASE_URL',
            'TWILIO_ACCOUNT_SID',
            'TWILIO_AUTH_TOKEN',
            'WABA_NUMBER',
            'RAZORPAY_KEY_ID',
            'RAZORPAY_KEY_SECRET'
        ];
        
        let allPresent = true;
        required.forEach(varName => {
            if (!process.env[varName]) {
                log('FAIL', `✗ Missing: ${varName}`);
                allPresent = false;
            }
        });
        
        if (allPresent) {
            log('PASS', '✓ All critical environment variables present');
            passed++;
        } else {
            failed++;
        }
    } catch (error) {
        log('FAIL', `✗ Environment test error: ${error.message}`);
        failed++;
    }
    
    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n' + colors.bold + '═══════════════════════════════════════════════════════════');
    console.log('📊 TEST RESULTS');
    console.log('═══════════════════════════════════════════════════════════' + colors.reset + '\n');
    
    console.log(`${colors.green}✓ Passed: ${passed}${colors.reset}`);
    console.log(`${colors.red}✗ Failed: ${failed}${colors.reset}`);
    console.log(`${colors.yellow}⚠ Warnings: ${warnings}${colors.reset}`);
    
    const total = passed + failed;
    const score = total > 0 ? Math.round((passed / total) * 100) : 0;
    
    console.log(`\n${colors.bold}Score: ${score}%${colors.reset}`);
    
    if (failed === 0) {
        console.log(`\n${colors.green}${colors.bold}✅ ALL SECURITY TESTS PASSED!${colors.reset}\n`);
        process.exit(0);
    } else {
        console.log(`\n${colors.red}${colors.bold}❌ SECURITY TESTS FAILED${colors.reset}`);
        console.log(`${colors.red}Please fix the issues above before deploying to production.${colors.reset}\n`);
        process.exit(1);
    }
}

// Run tests
runTests().catch(error => {
    console.error('Fatal error running tests:', error);
    process.exit(1);
});
