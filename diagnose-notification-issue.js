// diagnose-notification-issue.js
require('dotenv').config();
const twilio = require('twilio');
const { neon } = require('@neondatabase/serverless');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const sql = neon(process.env.DATABASE_URL);

async function diagnose() {
    console.log('🔍 DIAGNOSING NOTIFICATION ISSUE\n');
    console.log('================================\n');
    
    // 1. Check if credentials changed
    console.log('1️⃣ TWILIO CREDENTIALS:');
    console.log('   Account SID:', process.env.TWILIO_ACCOUNT_SID);
    console.log('   Auth Token:', process.env.TWILIO_AUTH_TOKEN ? '✅ Set' : '❌ Missing');
    console.log('   WABA Number:', process.env.WABA_NUMBER);
    console.log('');
    
    // 2. Check database configuration
    console.log('2️⃣ DATABASE CONFIGURATION:');
    const clinic = await sql`
        SELECT doctor_whatsapp, auto_approve FROM clinics WHERE id = 1
    `;
    console.log('   Doctor WhatsApp:', clinic[0].doctor_whatsapp);
    console.log('   Auto-approve:', clinic[0].auto_approve);
    console.log('');
    
    // 3. Check recent message attempts
    console.log('3️⃣ RECENT MESSAGE ATTEMPTS:');
    try {
        const messages = await client.messages.list({ 
            to: 'whatsapp:+919748006945',
            limit: 5 
        });
        
        console.log(`   Found ${messages.length} recent messages to doctor\n`);
        
        messages.forEach((msg, i) => {
            console.log(`   Message ${i + 1}:`);
            console.log(`   ├─ Status: ${msg.status}`);
            console.log(`   ├─ Date: ${msg.dateCreated.toLocaleString('en-IN')}`);
            console.log(`   ├─ Error Code: ${msg.errorCode || 'None'}`);
            console.log(`   └─ Error Message: ${msg.errorMessage || 'None'}`);
            console.log('');
        });
        
        // Check for common issues
        const failedMessages = messages.filter(m => 
            m.status === 'failed' || m.status === 'undelivered'
        );
        
        if (failedMessages.length > 0) {
            console.log('⚠️ FOUND FAILED MESSAGES!\n');
            
            failedMessages.forEach(msg => {
                console.log('❌ Failed Message Details:');
                console.log(`   Error Code: ${msg.errorCode}`);
                console.log(`   Error: ${msg.errorMessage}`);
                console.log(`   Check: https://console.twilio.com/us1/monitor/logs/sms/${msg.sid}`);
                console.log('');
                
                // Specific error diagnosis
                if (msg.errorCode === 63007) {
                    console.log('🔍 ERROR 63007: Recipient not in sandbox');
                    console.log('💡 SOLUTION: Doctor needs to rejoin the sandbox');
                    console.log('   1. Doctor sends to: +14155238886');
                    console.log('   2. Message content: join <your-sandbox-code>');
                    console.log('');
                }
                
                if (msg.errorCode === 21610) {
                    console.log('🔍 ERROR 21610: Message not allowed from sandbox');
                    console.log('💡 SOLUTION: Upgrade to approved WhatsApp Business');
                    console.log('');
                }
            });
        } else if (messages.length > 0) {
            const lastStatus = messages[0].status;
            console.log(`📊 Latest Message Status: ${lastStatus}\n`);
            
            if (lastStatus === 'sent' || lastStatus === 'delivered') {
                console.log('✅ Messages ARE being delivered!');
                console.log('💡 Check if doctor is checking the correct WhatsApp number');
                console.log('💡 Doctor should check: +919748006945\n');
            } else if (lastStatus === 'queued' || lastStatus === 'sending') {
                console.log('⏳ Message is still being processed');
                console.log('💡 Check again in a few moments\n');
            }
        }
        
    } catch (error) {
        console.error('❌ Error fetching messages:', error.message);
    }
    
    // 4. Test message sending NOW
    console.log('4️⃣ SENDING TEST MESSAGE NOW:');
    try {
        const testMsg = await client.messages.create({
            from: process.env.WABA_NUMBER,
            to: 'whatsapp:+919748006945',
            body: `🧪 TEST at ${new Date().toLocaleTimeString('en-IN')}\n\nIf you see this, notifications are working!\n\nReply "OK" to confirm.`
        });
        
        console.log('   ✅ Test message sent!');
        console.log(`   Message SID: ${testMsg.sid}`);
        console.log(`   Status: ${testMsg.status}`);
        console.log(`   Check status: https://console.twilio.com/us1/monitor/logs/sms/${testMsg.sid}`);
        console.log('');
        
        // Wait a bit and check status
        console.log('   ⏳ Waiting 3 seconds to check delivery...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const updatedMsg = await client.messages(testMsg.sid).fetch();
        console.log(`   📊 Updated Status: ${updatedMsg.status}`);
        
        if (updatedMsg.errorCode) {
            console.log(`   ❌ Error Code: ${updatedMsg.errorCode}`);
            console.log(`   ❌ Error: ${updatedMsg.errorMessage}`);
        }
        
    } catch (error) {
        console.error('   ❌ Failed to send test:', error.message);
        if (error.code) {
            console.error(`   ❌ Twilio Error Code: ${error.code}`);
        }
    }
    
    console.log('');
    console.log('================================');
    console.log('DIAGNOSIS COMPLETE');
}

diagnose().catch(console.error);
