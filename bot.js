require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const pool = require('./db');
const { getClinics, setClinicSession, getSession } = require('./handlers/clinicSelection');
const { saveAppointment, getAvailableSlots, isBusinessHours } = require('./handlers/appointmentBooking');
const { notifyDoctor } = require('./handlers/notifications');
const { isDoctor, handleDoctorCommand } = require('./handlers/doctorCommands');
const { getUserLanguage, setUserLanguage, getMessage, isLanguageSelection, getLanguageFromSelection } = require('./handlers/languageHandler');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'WhatsApp Clinic Bot (Multilingual)',
    version: '2.0',
    languages: ['en', 'bn', 'hi'],
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.status(200).json({
      status: 'healthy',
      database: 'connected',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.post('/webhook', async (req, res) => {
  const { From, Body } = req.body;
  const userPhone = From;
  const userMessage = Body.trim();
  
  console.log(`📨 Received from ${userPhone}: ${userMessage}`);
  
  try {
    // Check if user is a doctor
    console.log(`🔍 Checking if ${userPhone} is a doctor...`);
    const doctorCheck = await isDoctor(userPhone);
    console.log(`🔍 Doctor check result: ${doctorCheck}`);
    
    if (doctorCheck) {
      console.log(`✅ User is a doctor, handling command: ${userMessage}`);
      const commandResponse = await handleDoctorCommand(userPhone, userMessage, twilioClient);
      console.log(`📝 Command response: ${commandResponse ? 'Got response' : 'No response (null)'}`);
      
      if (commandResponse) {
        console.log(`💬 Sending doctor response...`);
        await sendWhatsAppMessage(userPhone, commandResponse);
        return res.sendStatus(200);
      }
      console.log(`⚠️ No command response, continuing to patient flow...`);
    }
    
    // Get user's current language
    let userLanguage = await getUserLanguage(userPhone);
    const session = await getSession(userPhone);
    
    // Handle greeting and language selection
    if (!session || !session.clinic_id) {
      const normalizedMessage = userMessage.toLowerCase().trim();
      const greetings = ['hi', 'hello', 'start', 'hey'];
      const isGreeting = greetings.includes(normalizedMessage);
      
      // Show language selection on greeting
      if (isGreeting) {
        await sendWhatsAppMessage(userPhone, getMessage('en', 'greeting'));
        return res.sendStatus(200);
      }
      
      // Handle language selection ONLY if user hasn't selected language yet
      if (!userLanguage && isLanguageSelection(userMessage)) {
        const selectedLanguage = getLanguageFromSelection(userMessage);
        await setUserLanguage(userPhone, selectedLanguage);
        userLanguage = selectedLanguage;
        
        // Show clinic list after language selection
        const clinics = await getClinics();
        
        if (clinics.length === 0) {
          await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'errorMessage'));
          return res.sendStatus(200);
        }
        
        let clinicList = getMessage(userLanguage, 'clinicSelection') + '\n\n';
        
        clinics.forEach((clinic, index) => {
          clinicList += `${index + 1}️⃣ ${clinic.name}\n`;
        });
        
        clinicList += getMessage(userLanguage, 'replyWithNumber');
        
        await sendWhatsAppMessage(userPhone, clinicList);
        return res.sendStatus(200);
      }
      
      // Handle clinic selection (only process numbers if language is already selected)
      if (userLanguage) {
        const clinicNumber = parseInt(userMessage);
        
        if (isNaN(clinicNumber) || clinicNumber < 1) {
          await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'welcomeMessage'));
          return res.sendStatus(200);
        }
        
        const clinics = await getClinics();
        
        if (clinicNumber > clinics.length) {
          const message = getMessage(userLanguage, 'invalidSelection', { count: clinics.length }) + 
                         getMessage(userLanguage, 'typeHiToRestart');
          await sendWhatsAppMessage(userPhone, message);
          return res.sendStatus(200);
        }
        
        const selectedClinic = clinics[clinicNumber - 1];
        
        await setClinicSession(userPhone, selectedClinic.id);
        
        await pool.query(
          `UPDATE sessions SET current_step = $1, language = $2, updated_at = NOW() WHERE user_phone = $3`,
          ['awaiting_name', userLanguage, userPhone]
        );
        
        await sendWhatsAppMessage(
          userPhone, 
          getMessage(userLanguage, 'clinicSelected', { clinicName: selectedClinic.name })
        );
        
        return res.sendStatus(200);
      } else {
        // If no language selected yet, prompt for language selection
        await sendWhatsAppMessage(userPhone, getMessage('en', 'welcomeMessage'));
        return res.sendStatus(200);
      }
    }
    
    // Use user's language from session if not set
    if (!userLanguage && session) {
      userLanguage = session.language || 'en';
    }
    
    // Handle name input
    if (session.current_step === 'awaiting_name') {
      const name = userMessage.trim();
      
      if (name.length < 2) {
        await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'invalidName'));
        return res.sendStatus(200);
      }
      
      const updatedTempData = { ...session.temp_data, name: name };
      
      await pool.query(
        `UPDATE sessions SET current_step = $1, temp_data = $2, updated_at = NOW() WHERE user_phone = $3`,
        ['awaiting_date', updatedTempData, userPhone]
      );
      
      await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'enterDate'));
      
      return res.sendStatus(200);
    }
    
    // Handle date input
    if (session.current_step === 'awaiting_date') {
      const dateRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      const match = userMessage.match(dateRegex);
      
      if (!match) {
        await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'invalidDateFormat'));
        return res.sendStatus(200);
      }
      
      const [_, day, month, year] = match;
      const appointmentDate = `${year}-${month}-${day}`;
      
      const selectedDate = new Date(appointmentDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      if (selectedDate < today) {
        await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'pastDate'));
        return res.sendStatus(200);
      }
      
      const updatedTempData = { ...session.temp_data, date: appointmentDate };
      
      await pool.query(
        `UPDATE sessions SET current_step = $1, temp_data = $2, updated_at = NOW() WHERE user_phone = $3`,
        ['awaiting_slot', updatedTempData, userPhone]
      );
      
      const availableSlots = await getAvailableSlots(session.clinic_id, appointmentDate);
      
      if (availableSlots.length === 0) {
        await sendWhatsAppMessage(
          userPhone, 
          getMessage(userLanguage, 'noSlotsAvailable', { date: `${day}-${month}-${year}` })
        );
        await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
        return res.sendStatus(200);
      }
      
      let slotMessage = getMessage(userLanguage, 'availableSlots') + '\n\n';
      availableSlots.forEach((slot, index) => {
        slotMessage += `${index + 1}️⃣ ${slot}\n`;
      });
      slotMessage += getMessage(userLanguage, 'replyWithSlot');
      
      await sendWhatsAppMessage(userPhone, slotMessage);
      return res.sendStatus(200);
    }
    
    // Handle slot selection
    if (session.current_step === 'awaiting_slot') {
      try {
        const slotNumber = parseInt(userMessage);
        const tempData = session.temp_data;
        
        const availableSlots = await getAvailableSlots(session.clinic_id, tempData.date);
        
        if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > availableSlots.length) {
          await sendWhatsAppMessage(
            userPhone, 
            getMessage(userLanguage, 'invalidSlot', { count: availableSlots.length })
          );
          return res.sendStatus(200);
        }
        
        const selectedSlot = availableSlots[slotNumber - 1];
        const autoApprove = await isBusinessHours(session.clinic_id);
        const appointmentStatus = autoApprove ? 'confirmed' : 'pending';
        
        console.log(`📝 Booking status: ${appointmentStatus} (Auto-approve: ${autoApprove})`);
        
        const appointmentId = await saveAppointment(
          session.clinic_id, 
          tempData.name, 
          userPhone.replace('whatsapp:', ''), 
          tempData.date, 
          selectedSlot, 
          appointmentStatus
        );
        
        const [year, month, day] = tempData.date.split('-');
        
        // Send confirmation message based on status
        if (appointmentStatus === 'confirmed') {
          await sendWhatsAppMessage(
            userPhone, 
            getMessage(userLanguage, 'appointmentConfirmed', {
              clinicName: tempData.clinic_name,
              patientName: tempData.name,
              date: `${day}-${month}-${year}`,
              slot: selectedSlot,
              appointmentId: appointmentId
            })
          );
          
          try {
            await notifyDoctor(twilioClient, session.clinic_id, {
              appointmentId,
              patientName: tempData.name,
              patientPhone: userPhone.replace('whatsapp:', ''),
              date: tempData.date,
              slot: selectedSlot,
              status: 'confirmed'
            });
          } catch (notifyError) {
            console.error('⚠️ Doctor notification failed:', notifyError.message);
          }
        } else {
          await sendWhatsAppMessage(
            userPhone, 
            getMessage(userLanguage, 'appointmentPending', {
              clinicName: tempData.clinic_name,
              patientName: tempData.name,
              date: `${day}-${month}-${year}`,
              slot: selectedSlot,
              appointmentId: appointmentId
            })
          );
          
          try {
            const clinicResult = await pool.query('SELECT doctor_whatsapp FROM clinics WHERE id = $1', [session.clinic_id]);
            
            if (clinicResult.rows.length > 0) {
              await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: clinicResult.rows[0].doctor_whatsapp,
                body: `🔔 *NEW APPOINTMENT REQUEST*\n\n📌 *Request ID:* #${appointmentId}\n👤 *Patient:* ${tempData.name}\n📞 *Phone:* ${userPhone.replace('whatsapp:', '')}\n📅 *Date:* ${day}-${month}-${year}\n⏰ *Time:* ${selectedSlot}\n\n⚠️ *Status:* PENDING (needs your approval)\n\nReply:\n✅ APPROVE ${appointmentId}\n❌ REJECT ${appointmentId}\n\nRequest received outside business hours.`
              });
            }
          } catch (notifyError) {
            console.error('⚠️ Doctor notification failed:', notifyError.message);
          }
        }
        
        await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
        
        console.log(`✅ Booking complete - ID: ${appointmentId}, Status: ${appointmentStatus}`);
        
        return res.sendStatus(200);
      } catch (error) {
        console.error('❌ Error in appointment booking:', error);
        await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'errorMessage'));
        return res.sendStatus(500);
      }
    }
    
    await sendWhatsAppMessage(userPhone, getMessage(userLanguage || 'en', 'welcomeMessage'));
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook Error:', error);
    const userLanguage = await getUserLanguage(userPhone) || 'en';
    await sendWhatsAppMessage(userPhone, getMessage(userLanguage, 'errorMessage'));
    res.sendStatus(500);
  }
});

async function sendWhatsAppMessage(to, body) {
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: body
    });
    console.log(`✅ Message sent to ${to}`);
  } catch (error) {
    console.error(`❌ Failed to send message to ${to}:`, error.message);
  }
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WhatsApp Clinic Bot (Multilingual) running on port ${PORT}`);
  console.log(`🌐 Supported languages: English, Bengali, Hindi`);
  console.log(`✅ Server started at: ${new Date().toISOString()}`);
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
