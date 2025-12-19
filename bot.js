require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { syncCustomer, logInteraction, getCustomer } = require('./utils/customerSync');
const db = require('./config/database');

const app = express();
const port = process.env.PORT || 3000;

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER || process.env.WABA_NUMBER;

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Import handlers
const appointmentHandler = require('./handlers/appointmentBooking');

// =====================================================
// SESSION MANAGEMENT - DATABASE-BACKED (NEW)
// =====================================================
const sessionManager = require('./utils/sessionManager');

// Cleanup sessions every 10 minutes
setInterval(async () => {
    await sessionManager.cleanupSessions();
}, 10 * 60 * 1000);

/**
 * Get clinic ID from phone number or WABA routing
 */
async function getClinicIdFromPhone(toNumber) {
    try {
        // Query database for clinic based on WABA number using doctor_whatsapp column
        const result = await db.query(
            `SELECT id FROM clinics WHERE doctor_whatsapp = $1`,
            [toNumber]
        );
        
        if (result.rows.length > 0) {
            return result.rows[0].id;
        }
        
        // Default clinic ID if not found
        console.log(`⚠️ No clinic found for ${toNumber}, using default clinic ID 1`);
        return 1;
    } catch (error) {
        console.error('❌ Error getting clinic ID:', error.message);
        return 1; // Fallback to default clinic
    }
}

/**
 * Detect language from message content
 */
function detectLanguage(message) {
    const bengaliPattern = /[\u0980-\u09FF]/;
    const hindiPattern = /[\u0900-\u097F]/;
    
    if (bengaliPattern.test(message)) {
        return 'bn';
    } else if (hindiPattern.test(message)) {
        return 'hi';
    }
    return 'en';
}

/**
 * Get greeting message based on language
 */
function getGreeting(language, customerName) {
    const greetings = {
        en: `Hello${customerName ? ' ' + customerName : ''}! 👋\n\nWelcome to our clinic. How can I help you today?\n\n1️⃣ Book Appointment\n2️⃣ Check Availability\n3️⃣ View Services\n4️⃣ Contact Info\n\nReply with a number or describe your query.`,
        hi: `नमस्ते${customerName ? ' ' + customerName : ''}! 👋\n\nहमारे क्लिनिक में आपका स्वागत है। मैं आज आपकी कैसे मदद कर सकता हूं?\n\n1️⃣ अपॉइंटमेंट बुक करें\n2️⃣ उपलब्धता जांचें\n3️⃣ सेवाएं देखें\n4️⃣ संपर्क जानकारी\n\nएक नंबर के साथ जवाब दें या अपनी क्वेरी का वर्णन करें।`,
        bn: `হ্যালো${customerName ? ' ' + customerName : ''}! 👋\n\nআমাদের ক্লিনিকে আপনাকে স্বাগতম। আজ আমি আপনাকে কিভাবে সাহায্য করতে পারি?\n\n1️⃣ অ্যাপয়েন্টমেন্ট বুক করুন\n2️⃣ উপলব্ধতা চেক করুন\n3️⃣ সেবা দেখুন\n4️⃣ যোগাযোগের তথ্য\n\nএকটি নম্বর দিয়ে উত্তর দিন বা আপনার প্রশ্ন বর্ণনা করুন।`
    };
    
    return greetings[language] || greetings.en;
}

/**
 * Process incoming message based on session state
 */
async function processMessage(message, phoneNumber, clinicId) {
    const session = await sessionManager.getSession(phoneNumber);
    const customer = await getCustomer(phoneNumber, clinicId);
    
    // Update language preference based on message
    const detectedLang = detectLanguage(message);
    if (detectedLang !== session.language) {
        session.language = detectedLang;
        await sessionManager.updateSession(phoneNumber, { language: detectedLang });
        
        // Update customer language preference
        if (customer) {
            await syncCustomer(phoneNumber, clinicId, { 
                languagePreference: detectedLang 
            });
        }
    }
    
    const messageText = message.trim().toLowerCase();
    
    // Handle different stages
    switch (session.stage) {
        case 'initial':
            return handleInitialStage(messageText, session, customer, phoneNumber);
            
        case 'booking_name':
            return await handleBookingName(messageText, phoneNumber, clinicId, session);
            
        case 'booking_date':
            return await handleBookingDate(messageText, phoneNumber, clinicId, session);
            
        case 'booking_time':
            return await handleBookingTime(messageText, phoneNumber, clinicId, session);
            
        case 'booking_confirm':
            return await handleBookingConfirm(messageText, phoneNumber, clinicId, session);
            
        default:
            return handleInitialStage(messageText, session, customer, phoneNumber);
    }
}

/**
 * Handle initial stage - main menu
 */
async function handleInitialStage(message, session, customer, phoneNumber) {
    const customerName = customer?.name || null;
    
    // Check for menu options
    if (message === '1' || message.includes('book') || message.includes('appointment')) {
        await sessionManager.updateSession(phoneNumber, { stage: 'booking_name' });
        return getResponse('booking_start', session.language);
    }
    
    if (message === '2' || message.includes('availability') || message.includes('check')) {
        return getResponse('availability', session.language);
    }
    
    if (message === '3' || message.includes('service')) {
        return getResponse('services', session.language);
    }
    
    if (message === '4' || message.includes('contact')) {
        return getResponse('contact', session.language);
    }
    
    // Default greeting
    return getGreeting(session.language, customerName);
}

/**
 * Handle booking - collect name
 */
async function handleBookingName(message, phoneNumber, clinicId, session) {
    const name = message.trim();
    
    if (name.length < 2) {
        return getResponse('invalid_name', session.language);
    }
    
    // Save name to session and customer database
    session.data.name = name;
    await syncCustomer(phoneNumber, clinicId, { name });
    
    await sessionManager.updateSession(phoneNumber, { 
        stage: 'booking_date',
        data: session.data 
    });
    
    return getResponse('booking_date', session.language, { name });
}

/**
 * Handle booking - collect date
 */
async function handleBookingDate(message, phoneNumber, clinicId, session) {
    // Simple date validation
    const datePattern = /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
    
    if (!datePattern.test(message)) {
        return getResponse('invalid_date', session.language);
    }
    
    session.data.date = message.trim();
    await sessionManager.updateSession(phoneNumber, { 
        stage: 'booking_time',
        data: session.data 
    });
    
    return getResponse('booking_time', session.language);
}

/**
 * Handle booking - collect time
 */
async function handleBookingTime(message, phoneNumber, clinicId, session) {
    const timePattern = /\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)/i;
    
    if (!timePattern.test(message)) {
        return getResponse('invalid_time', session.language);
    }
    
    session.data.time = message.trim();
    await sessionManager.updateSession(phoneNumber, { 
        stage: 'booking_confirm',
        data: session.data 
    });
    
    return getResponse('booking_confirm', session.language, session.data);
}

/**
 * Handle booking - confirmation
 */
async function handleBookingConfirm(message, phoneNumber, clinicId, session) {
    if (message === 'yes' || message === 'confirm' || message === '1') {
        try {
            // Save appointment to database
            const appointment = await appointmentHandler.bookAppointment(
                phoneNumber,
                clinicId,
                session.data
            );
            
            // Reset session
            await sessionManager.updateSession(phoneNumber, { 
                stage: 'initial',
                data: {} 
            });
            
            return getResponse('booking_success', session.language, {
                ...session.data,
                appointmentId: appointment.id
            });
        } catch (error) {
            console.error('❌ Booking error:', error.message);
            return getResponse('booking_error', session.language);
        }
    } else {
        // Cancel booking
        await sessionManager.updateSession(phoneNumber, { 
            stage: 'initial',
            data: {} 
        });
        return getResponse('booking_cancelled', session.language);
    }
}

/**
 * Get response templates in multiple languages
 */
function getResponse(type, language, data = {}) {
    const responses = {
        booking_start: {
            en: "Great! Let's book your appointment. 📅\n\nPlease tell me your name:",
            hi: "बढ़िया! आइए अपनी अपॉइंटमेंट बुक करें। 📅\n\nकृपया मुझे अपना नाम बताएं:",
            bn: "চমৎকার! আপনার অ্যাপয়েন্টমেন্ট বুক করি। 📅\n\nঅনুগ্রহ করে আমাকে আপনার নাম বলুন:"
        },
        invalid_name: {
            en: "Please enter a valid name (at least 2 characters):",
            hi: "कृपया एक वैध नाम दर्ज करें (कम से कम 2 अक्षर):",
            bn: "অনুগ্রহ করে একটি বৈধ নাম লিখুন (কমপক্ষে 2 অক্ষর):"
        },
        booking_date: {
            en: `Thank you, ${data.name}! 🙏\n\nWhat date would you like to book?\n(Format: DD/MM/YYYY or DD-MM-YYYY)`,
            hi: `धन्यवाद, ${data.name}! 🙏\n\nआप किस तारीख को बुक करना चाहेंगे?\n(प्रारूप: DD/MM/YYYY या DD-MM-YYYY)`,
            bn: `ধন্যবাদ, ${data.name}! 🙏\n\nআপনি কোন তারিখে বুক করতে চান?\n(ফরম্যাট: DD/MM/YYYY অথবা DD-MM-YYYY)`
        },
        invalid_date: {
            en: "Please enter a valid date (Format: DD/MM/YYYY):",
            hi: "कृपया एक वैध तारीख दर्ज करें (प्रारूप: DD/MM/YYYY):",
            bn: "অনুগ্রহ করে একটি বৈধ তারিখ লিখুন (ফরম্যাট: DD/MM/YYYY):"
        },
        booking_time: {
            en: "What time works best for you?\n(Format: HH:MM or HH:MM AM/PM)",
            hi: "आपके लिए कौन सा समय सबसे अच्छा है?\n(प्रारूप: HH:MM या HH:MM AM/PM)",
            bn: "আপনার জন্য কোন সময় সবচেয়ে ভালো?\n(ফরম্যাট: HH:MM অথবা HH:MM AM/PM)"
        },
        invalid_time: {
            en: "Please enter a valid time (Format: HH:MM or HH:MM AM/PM):",
            hi: "कृपया एक वैध समय दर्ज करें (प्रारूप: HH:MM या HH:MM AM/PM):",
            bn: "অনুগ্রহ করে একটি বৈধ সময় লিখুন (ফরম্যাট: HH:MM অথবা HH:MM AM/PM):"
        },
        booking_confirm: {
            en: `📋 Please confirm your appointment:\n\n👤 Name: ${data.name}\n📅 Date: ${data.date}\n🕒 Time: ${data.time}\n\nReply 'YES' to confirm or 'NO' to cancel.`,
            hi: `📋 कृपया अपनी अपॉइंटमेंट की पुष्टि करें:\n\n👤 नाम: ${data.name}\n📅 तारीख: ${data.date}\n🕒 समय: ${data.time}\n\nपुष्टि करने के लिए 'YES' या रद्द करने के लिए 'NO' का जवाब दें।`,
            bn: `📋 অনুগ্রহ করে আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত করুন:\n\n👤 নাম: ${data.name}\n📅 তারিখ: ${data.date}\n🕒 সময়: ${data.time}\n\nনিশ্চিত করতে 'YES' বা বাতিল করতে 'NO' উত্তর দিন।`
        },
        booking_success: {
            en: `✅ Appointment confirmed!\n\n📋 Booking ID: #${data.appointmentId}\n👤 Name: ${data.name}\n📅 Date: ${data.date}\n🕒 Time: ${data.time}\n\nWe'll see you then! Reply with 'MENU' to return to main menu.`,
            hi: `✅ अपॉइंटमेंट की पुष्टि हो गई!\n\n📋 बुकिंग ID: #${data.appointmentId}\n👤 नाम: ${data.name}\n📅 तारीख: ${data.date}\n🕒 समय: ${data.time}\n\nहम आपको तब देखेंगे! मुख्य मेनू पर वापस जाने के लिए 'MENU' का जवाब दें।`,
            bn: `✅ অ্যাপয়েন্টমেন্ট নিশ্চিত হয়েছে!\n\n📋 বুকিং ID: #${data.appointmentId}\n👤 নাম: ${data.name}\n📅 তারিখ: ${data.date}\n🕒 সময়: ${data.time}\n\nআমরা তখন আপনাকে দেখব! মূল মেনুতে ফিরে যেতে 'MENU' উত্তর দিন।`
        },
        booking_cancelled: {
            en: "❌ Booking cancelled. Reply 'MENU' to return to main menu.",
            hi: "❌ बुकिंग रद्द। मुख्य मेनू पर वापस जाने के लिए 'MENU' का जवाब दें।",
            bn: "❌ বুকিং বাতিল। মূল মেনুতে ফিরে যেতে 'MENU' উত্তর দিন।"
        },
        booking_error: {
            en: "❌ Sorry, there was an error booking your appointment. Please try again or contact us directly.",
            hi: "❌ क्षमा करें, आपकी अपॉइंटमेंट बुक करने में एक त्रुटि थी। कृपया फिर से प्रयास करें या हमसे सीधे संपर्क करें।",
            bn: "❌ দুঃখিত, আপনার অ্যাপয়েন্টমেন্ট বুক করতে একটি ত্রুটি হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন বা সরাসরি আমাদের সাথে যোগাযোগ করুন।"
        },
        availability: {
            en: "📅 Our clinic is open:\n\nMonday - Friday: 9:00 AM - 6:00 PM\nSaturday: 9:00 AM - 2:00 PM\nSunday: Closed\n\nReply 'MENU' for main menu.",
            hi: "📅 हमारा क्लिनिक खुला है:\n\nसोमवार - शुक्रवार: सुबह 9:00 बजे - शाम 6:00 बजे\nशनिवार: सुबह 9:00 बजे - दोपहर 2:00 बजे\nरविवार: बंद\n\nमुख्य मेनू के लिए 'MENU' का जवाब दें।",
            bn: "📅 আমাদের ক্লিনিক খোলা:\n\nসোমবার - শুক্রবার: সকাল 9:00 - সন্ধ্যা 6:00\nশনিবার: সকাল 9:00 - দুপুর 2:00\nরবিবার: বন্ধ\n\nমূল মেনুর জন্য 'MENU' উত্তর দিন।"
        },
        services: {
            en: "🏥 Our Services:\n\n• General Consultation\n• Health Checkups\n• Vaccinations\n• Lab Tests\n• Minor Procedures\n\nReply 'MENU' for main menu.",
            hi: "🏥 हमारी सेवाएं:\n\n• सामान्य परामर्श\n• स्वास्थ्य जांच\n• टीकाकरण\n• लैब टेस्ट\n• मामूली प्रक्रियाएं\n\nमुख्य मेनू के लिए 'MENU' का जवाब दें।",
            bn: "🏥 আমাদের সেবাসমূহ:\n\n• সাধারণ পরামর্শ\n• স্বাস্থ্য পরীক্ষা\n• টিকাকরণ\n• ল্যাব পরীক্ষা\n• ছোট প্রক্রিয়া\n\nমূল মেনুর জন্য 'MENU' উত্তর দিন।"
        },
        contact: {
            en: "📞 Contact Us:\n\nPhone: +91-7980407413\nEmail: clinic@example.com\nAddress: 123 Main St, Kolkata\n\nReply 'MENU' for main menu.",
            hi: "📞 हमसे संपर्क करें:\n\nफोन: +91-7980407413\nईमेल: clinic@example.com\nपता: 123 Main St, कोलकाता\n\nमुख्य मेनू के लिए 'MENU' का जवाब दें।",
            bn: "📞 যোগাযোগ:\n\nফোন: +91-7980407413\nইমেল: clinic@example.com\nঠিকানা: 123 Main St, কলকাতা\n\nমূল মেনুর জন্য 'MENU' উত্তর দিন।"
        }
    };
    
    return responses[type]?.[language] || responses[type]?.en || "Invalid response type";
}

/**
 * Send WhatsApp message via Twilio
 */
async function sendWhatsAppMessage(to, message) {
    try {
        await twilioClient.messages.create({
            from: twilioWhatsAppNumber,
            to: `whatsapp:${to}`,
            body: message
        });
        console.log(`✅ Message sent to ${to}`);
    } catch (error) {
        console.error('❌ Error sending message:', error.message);
        throw error;
    }
}

/**
 * Main webhook endpoint
 */
app.post('/webhook', async (req, res) => {
    try {
        const { From, Body, ProfileName, To } = req.body;
        const phoneNumber = From.replace('whatsapp:', '');
        const toNumber = To?.replace('whatsapp:', '') || twilioWhatsAppNumber.replace('whatsapp:', '');
        
        console.log(`📩 Received from ${phoneNumber}: ${Body}`);
        
        // Get clinic ID from routing
        const clinicId = await getClinicIdFromPhone(toNumber);
        
        // Sync customer (create or update)
        await syncCustomer(phoneNumber, clinicId, {
            name: ProfileName,
            languagePreference: detectLanguage(Body)
        });
        
        // Get session (database-backed)
        const session = await sessionManager.getSession(phoneNumber);
        
        // Process message and get response
        const response = await processMessage(Body, phoneNumber, clinicId);
        
        // Log interaction
        await logInteraction(phoneNumber, clinicId, session.stage, Body, response);
        
        // Send response via Twilio
        await sendWhatsAppMessage(phoneNumber, response);
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.sendStatus(500);
    }
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        
        // Get session stats
        const sessionStats = await sessionManager.getSessionStats();
        
        res.json({ 
            status: 'healthy',
            timestamp: new Date().toISOString(),
            sessions: sessionStats || { total_sessions: 0 }
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy',
            error: error.message 
        });
    }
});

/**
 * Get customer stats (admin endpoint)
 */
app.get('/api/stats/:clinicId', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const stats = await require('./utils/customerSync').getCustomerStats(clinicId);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Analytics routes
 */
const analyticsRouter = require('./routes/analytics');
app.use('/api/analytics', analyticsRouter);

/**
 * Start server
 */
app.listen(port, () => {
    console.log(`🚀 WhatsApp Bot running on port ${port}`);
    console.log(`📱 Webhook URL: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`}/webhook`);
    console.log(`💾 Session storage: Database-backed (persistent)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
