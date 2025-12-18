const pool = require('../db');

// Language translations
const translations = {
  en: {
    greeting: "🏥 *Welcome to Appointment Booking*\n\nPlease select your language:\n\n1️⃣ English\n2️⃣ বাংলা (Bengali)\n3️⃣ हिंदी (Hindi)",
    clinicSelection: "📋 Select your clinic:",
    replyWithNumber: "\n💬 Reply with the number (e.g., 1)",
    invalidSelection: "❌ Invalid selection. Please choose between 1 and",
    typeHiToRestart: "\n\nType *hi* to see the list again.",
    clinicSelected: "✅ You selected *{clinicName}*\n\n👤 Please enter your *full name*:",
    invalidName: "❌ Please enter a valid name (at least 2 characters).",
    enterDate: "📅 *Enter appointment date*\n\nFormat: DD-MM-YYYY\nExample: 20-12-2024\n\n⚠️ Date must be today or later.",
    invalidDateFormat: "❌ Invalid date format.\n\nUse: DD-MM-YYYY\nExample: 20-12-2024",
    pastDate: "❌ Cannot book appointments in the past.\n\nPlease enter a current or future date.",
    noSlotsAvailable: "❌ *No slots available* for {date}\n\nType *hi* to restart and select a different date.",
    availableSlots: "⏰ *Available Time Slots*",
    replyWithSlot: "\n💬 Reply with the slot number:",
    invalidSlot: "❌ Invalid slot number. Please select between 1 and {count}.",
    appointmentConfirmed: "✅ *Appointment CONFIRMED!*\n\n🏥 *Clinic:* {clinicName}\n👤 *Name:* {patientName}\n📅 *Date:* {date}\n⏰ *Time:* {slot}\n\n📌 *Booking ID:* #{appointmentId}\n\n✨ Your appointment is confirmed!\nSee you soon! 👋\n\n_Type *hi* to book another appointment._",
    appointmentPending: "⏳ *Appointment Request Submitted*\n\n🏥 *Clinic:* {clinicName}\n👤 *Name:* {patientName}\n📅 *Date:* {date}\n⏰ *Time:* {slot}\n\n📌 *Request ID:* #{appointmentId}\n\n⏰ Status: *PENDING APPROVAL*\n\nWe'll notify you once the doctor confirms!\nUsually within 24 hours.\n\n_Type *hi* to book another appointment._",
    welcomeMessage: "👋 Welcome! Type *hi* to start booking an appointment.",
    errorMessage: "❌ Something went wrong. Please type *hi* to restart."
  },
  bn: {
    greeting: "🏥 *অ্যাপয়েন্টমেন্ট বুকিংয়ে স্বাগতম*\n\nঅনুগ্রহ করে আপনার ভাষা নির্বাচন করুন:\n\n1️⃣ English\n2️⃣ বাংলা (Bengali)\n3️⃣ हिंदी (Hindi)",
    clinicSelection: "📋 আপনার ক্লিনিক নির্বাচন করুন:",
    replyWithNumber: "\n💬 নম্বর দিয়ে উত্তর দিন (যেমন: 1)",
    invalidSelection: "❌ ভুল নির্বাচন। অনুগ্রহ করে 1 থেকে {count} এর মধ্যে চয়ন করুন",
    typeHiToRestart: "\n\nআবার তালিকা দেখতে *hi* টাইপ করুন।",
    clinicSelected: "✅ আপনি *{clinicName}* নির্বাচন করেছেন\n\n👤 অনুগ্রহ করে আপনার *সম্পূর্ণ নাম* লিখুন:",
    invalidName: "❌ অনুগ্রহ করে একটি বৈধ নাম লিখুন (কমপক্ষে ২টি অক্ষর)।",
    enterDate: "📅 *অ্যাপয়েন্টমেন্ট তারিখ লিখুন*\n\nফরম্যাট: DD-MM-YYYY\nউদাহরণ: 20-12-2024\n\n⚠️ তারিখ আজ বা পরবর্তী হতে হবে।",
    invalidDateFormat: "❌ ভুল তারিখ ফরম্যাট।\n\nব্যবহার করুন: DD-MM-YYYY\nউদাহরণ: 20-12-2024",
    pastDate: "❌ অতীতের তারিখে অ্যাপয়েন্টমেন্ট বুক করা যাবে না।\n\nঅনুগ্রহ করে বর্তমান বা ভবিষ্যতের তারিখ লিখুন।",
    noSlotsAvailable: "❌ *কোনো স্লট উপলব্ধ নেই* {date} তারিখে\n\nঅন্য তারিখ নির্বাচন করতে *hi* টাইপ করুন।",
    availableSlots: "⏰ *উপলব্ধ সময় স্লট*",
    replyWithSlot: "\n💬 স্লট নম্বর দিয়ে উত্তর দিন:",
    invalidSlot: "❌ ভুল স্লট নম্বর। অনুগ্রহ করে 1 থেকে {count} এর মধ্যে নির্বাচন করুন।",
    appointmentConfirmed: "✅ *অ্যাপয়েন্টমেন্ট নিশ্চিত হয়েছে!*\n\n🏥 *ক্লিনিক:* {clinicName}\n👤 *নাম:* {patientName}\n📅 *তারিখ:* {date}\n⏰ *সময়:* {slot}\n\n📌 *বুকিং আইডি:* #{appointmentId}\n\n✨ আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত হয়েছে!\nশীঘ্রই দেখা হবে! 👋\n\n_আরেকটি অ্যাপয়েন্টমেন্ট বুক করতে *hi* টাইপ করুন।_",
    appointmentPending: "⏳ *অ্যাপয়েন্টমেন্ট অনুরোধ জমা দেওয়া হয়েছে*\n\n🏥 *ক্লিনিক:* {clinicName}\n👤 *নাম:* {patientName}\n📅 *তারিখ:* {date}\n⏰ *সময়:* {slot}\n\n📌 *অনুরোধ আইডি:* #{appointmentId}\n\n⏰ স্ট্যাটাস: *অনুমোদনের অপেক্ষায়*\n\nডাক্তার নিশ্চিত করলে আমরা আপনাকে জানাব!\nসাধারণত ২৪ ঘন্টার মধ্যে।\n\n_আরেকটি অ্যাপয়েন্টমেন্ট বুক করতে *hi* টাইপ করুন।_",
    welcomeMessage: "👋 স্বাগতম! অ্যাপয়েন্টমেন্ট বুকিং শুরু করতে *hi* টাইপ করুন।",
    errorMessage: "❌ কিছু ভুল হয়েছে। পুনরায় শুরু করতে *hi* টাইপ করুন।"
  },
  hi: {
    greeting: "🏥 *अपॉइंटमेंट बुकिंग में आपका स्वागत है*\n\nकृपया अपनी भाषा चुनें:\n\n1️⃣ English\n2️⃣ বাংলা (Bengali)\n3️⃣ हिंदी (Hindi)",
    clinicSelection: "📋 अपना क्लिनिक चुनें:",
    replyWithNumber: "\n💬 नंबर के साथ जवाब दें (जैसे: 1)",
    invalidSelection: "❌ गलत चयन। कृपया 1 से {count} के बीच चुनें",
    typeHiToRestart: "\n\nसूची फिर से देखने के लिए *hi* टाइप करें।",
    clinicSelected: "✅ आपने *{clinicName}* चुना\n\n👤 कृपया अपना *पूरा नाम* दर्ज करें:",
    invalidName: "❌ कृपया एक वैध नाम दर्ज करें (कम से कम 2 अक्षर)।",
    enterDate: "📅 *अपॉइंटमेंट की तारीख दर्ज करें*\n\nप्रारूप: DD-MM-YYYY\nउदाहरण: 20-12-2024\n\n⚠️ तारीख आज या बाद की होनी चाहिए।",
    invalidDateFormat: "❌ गलत तारीख प्रारूप।\n\nउपयोग करें: DD-MM-YYYY\nउदाहरण: 20-12-2024",
    pastDate: "❌ पुरानी तारीख पर अपॉइंटमेंट बुक नहीं कर सकते।\n\nकृपया वर्तमान या भविष्य की तारीख दर्ज करें।",
    noSlotsAvailable: "❌ *कोई स्लॉट उपलब्ध नहीं* {date} के लिए\n\nदूसरी तारीख चुनने के लिए *hi* टाइप करें।",
    availableSlots: "⏰ *उपलब्ध समय स्लॉट*",
    replyWithSlot: "\n💬 स्लॉट नंबर के साथ जवाब दें:",
    invalidSlot: "❌ गलत स्लॉट नंबर। कृपया 1 से {count} के बीच चुनें।",
    appointmentConfirmed: "✅ *अपॉइंटमेंट पुष्टि हो गई!*\n\n🏥 *क्लिनिक:* {clinicName}\n👤 *नाम:* {patientName}\n📅 *तारीख:* {date}\n⏰ *समय:* {slot}\n\n📌 *बुकिंग आईडी:* #{appointmentId}\n\n✨ आपकी अपॉइंटमेंट पुष्टि हो गई है!\nजल्द मिलेंगे! 👋\n\n_दूसरी अपॉइंटमेंट बुक करने के लिए *hi* टाइप करें।_",
    appointmentPending: "⏳ *अपॉइंटमेंट अनुरोध जमा किया गया*\n\n🏥 *क्लिनिक:* {clinicName}\n👤 *नाम:* {patientName}\n📅 *तारीख:* {date}\n⏰ *समय:* {slot}\n\n📌 *अनुरोध आईडी:* #{appointmentId}\n\n⏰ स्थिति: *अनुमोदन की प्रतीक्षा में*\n\nडॉक्टर की पुष्टि के बाद हम आपको सूचित करेंगे!\nआमतौर पर 24 घंटे के भीतर।\n\n_दूसरी अपॉइंटमेंट बुक करने के लिए *hi* टाइप करें।_",
    welcomeMessage: "👋 स्वागत है! अपॉइंटमेंट बुकिंग शुरू करने के लिए *hi* टाइप करें।",
    errorMessage: "❌ कुछ गलत हो गया। पुनः प्रारंभ करने के लिए *hi* टाइप करें।"
  }
};

/**
 * Get user's preferred language from session
 */
async function getUserLanguage(userPhone) {
  try {
    const result = await pool.query(
      'SELECT language FROM sessions WHERE user_phone = $1',
      [userPhone]
    );
    
    return result.rows.length > 0 ? result.rows[0].language : null;
  } catch (error) {
    console.error('❌ Error getting user language:', error);
    return null;
  }
}

/**
 * Set user's preferred language
 */
async function setUserLanguage(userPhone, language) {
  try {
    await pool.query(
      `INSERT INTO sessions (user_phone, language, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_phone) 
       DO UPDATE SET language = $2, updated_at = NOW()`,
      [userPhone, language]
    );
    
    console.log(`✅ Language set to ${language} for ${userPhone}`);
  } catch (error) {
    console.error('❌ Error setting user language:', error);
    throw error;
  }
}

/**
 * Get translated message
 */
function getMessage(language, key, replacements = {}) {
  const lang = translations[language] || translations.en;
  let message = lang[key] || translations.en[key] || key;
  
  // Replace placeholders
  Object.keys(replacements).forEach(placeholder => {
    message = message.replace(`{${placeholder}}`, replacements[placeholder]);
  });
  
  return message;
}

/**
 * Detect if user is selecting language (1, 2, or 3)
 */
function isLanguageSelection(message) {
  const normalized = message.trim();
  return ['1', '2', '3'].includes(normalized);
}

/**
 * Get language code from selection number
 */
function getLanguageFromSelection(selection) {
  const languageMap = {
    '1': 'en',
    '2': 'bn',
    '3': 'hi'
  };
  return languageMap[selection] || 'en';
}

module.exports = {
  getUserLanguage,
  setUserLanguage,
  getMessage,
  isLanguageSelection,
  getLanguageFromSelection,
  translations
};
