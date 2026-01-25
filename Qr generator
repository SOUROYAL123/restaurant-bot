// qr-generator.js
// Generate QR codes for all restaurants

const fs = require('fs').promises;
const path = require('path');

// You can use an online QR generator API or install qrcode package
// For now, this generates the URLs and instructions

const RESTAURANTS = [
    {
        id: 1,
        name: 'Zam Zam Restaurant',
        keyword: 'ZAMZAM',
        owner_phone: '+919876543210'
    },
    {
        id: 2,
        name: 'Spice Garden',
        keyword: 'SPICEGARDEN',
        owner_phone: '+919876543211'
    },
    {
        id: 3,
        name: 'The Curry House',
        keyword: 'CURRYHOUSE',
        owner_phone: '+919876543212'
    },
    {
        id: 4,
        name: 'Biryani Express',
        keyword: 'BIRYANIEXPRESS',
        owner_phone: '+919876543213'
    }
];

const WHATSAPP_NUMBER = '+917980407413';
const BASE_URL = 'https://wa.me/';

async function generateQRInstructions() {
    console.log('🎨 Generating QR Code Instructions...\n');
    
    let instructions = '# QR CODE GENERATION GUIDE\n\n';
    instructions += '## Restaurant QR Codes\n\n';
    instructions += 'Use these URLs to generate QR codes:\n\n';
    
    for (const restaurant of RESTAURANTS) {
        const whatsappUrl = `${BASE_URL}${WHATSAPP_NUMBER.replace('+', '')}?text=${restaurant.keyword}`;
        
        instructions += `### ${restaurant.name}\n`;
        instructions += `- **Keyword:** ${restaurant.keyword}\n`;
        instructions += `- **WhatsApp URL:** ${whatsappUrl}\n`;
        instructions += `- **QR Code Generator:** https://www.qr-code-generator.com/\n`;
        instructions += `  1. Select "WhatsApp"\n`;
        instructions += `  2. Enter: ${WHATSAPP_NUMBER}\n`;
        instructions += `  3. Message: ${restaurant.keyword}\n`;
        instructions += `  4. Download PNG (300x300 or larger)\n\n`;
    }
    
    instructions += '\n## Quick Links for Online Generation\n\n';
    
    for (const restaurant of RESTAURANTS) {
        const whatsappUrl = `${BASE_URL}${WHATSAPP_NUMBER.replace('+', '')}?text=${restaurant.keyword}`;
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(whatsappUrl)}`;
        
        instructions += `### ${restaurant.name}\n`;
        instructions += `Direct QR Image URL:\n`;
        instructions += `${qrCodeUrl}\n\n`;
    }
    
    instructions += '\n## Environment Variables for Owner Notifications\n\n';
    instructions += 'Add these to your .env file:\n\n';
    instructions += '```\n';
    
    for (const restaurant of RESTAURANTS) {
        const envKey = restaurant.keyword + '_OWNER_PHONE';
        instructions += `${envKey}=${restaurant.owner_phone}\n`;
    }
    
    instructions += '```\n';
    
    // Save to file
    await fs.writeFile('QR_CODES_INSTRUCTIONS.md', instructions);
    console.log('✅ Instructions saved to QR_CODES_INSTRUCTIONS.md\n');
    
    // Generate HTML with QR codes
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Restaurant QR Codes</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .restaurant-card {
            background: white;
            border-radius: 10px;
            padding: 30px;
            margin: 20px 0;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            page-break-inside: avoid;
        }
        h1 {
            color: #333;
            text-align: center;
        }
        h2 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        .qr-container {
            text-align: center;
            margin: 20px 0;
        }
        .qr-code {
            max-width: 400px;
            margin: 20px auto;
        }
        .keyword {
            background: #3498db;
            color: white;
            padding: 10px 20px;
            border-radius: 5px;
            display: inline-block;
            font-size: 24px;
            font-weight: bold;
        }
        .url {
            background: #ecf0f1;
            padding: 10px;
            border-radius: 5px;
            word-break: break-all;
            font-family: monospace;
            margin: 10px 0;
        }
        @media print {
            body { background: white; }
            .restaurant-card { 
                page-break-before: always;
                box-shadow: none;
                border: 1px solid #ddd;
            }
            .restaurant-card:first-child {
                page-break-before: avoid;
            }
        }
    </style>
</head>
<body>
    <h1>🍽️ Restaurant QR Codes</h1>
    <p style="text-align: center; color: #666;">Scan to order on WhatsApp</p>
`;
    
    for (const restaurant of RESTAURANTS) {
        const whatsappUrl = `${BASE_URL}${WHATSAPP_NUMBER.replace('+', '')}?text=${restaurant.keyword}`;
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(whatsappUrl)}`;
        
        html += `
    <div class="restaurant-card">
        <h2>${restaurant.name}</h2>
        <div class="qr-container">
            <p><span class="keyword">${restaurant.keyword}</span></p>
            <img src="${qrCodeUrl}" alt="QR Code for ${restaurant.name}" class="qr-code">
            <div class="url">
                <strong>WhatsApp URL:</strong><br>
                ${whatsappUrl}
            </div>
            <p style="color: #666; margin-top: 20px;">
                📱 Scan with your phone camera<br>
                💬 WhatsApp opens automatically<br>
                🍽️ Start ordering!
            </p>
        </div>
    </div>
`;
    }
    
    html += `
</body>
</html>`;
    
    await fs.writeFile('qr-codes.html', html);
    console.log('✅ QR Codes HTML saved to qr-codes.html\n');
    
    console.log('📋 Next Steps:');
    console.log('1. Open qr-codes.html in your browser');
    console.log('2. Print or save QR codes as images');
    console.log('3. Add owner phone numbers to .env file');
    console.log('4. Send QR codes to restaurants\n');
}

// Run generator
generateQRInstructions().catch(console.error);
