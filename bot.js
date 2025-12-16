require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const pool = require('./db');
const { getClinics, setClinicSession, getSession } = require('./handlers/clinicSelection');
const { saveAppointment, getAvailableSlots } = require('./handlers/appointmentBooking');
const { notifyDoctor } = require('./handlers/notifications');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp Clinic Bot',
    timestamp: new Date().toISOString()
  });
});

// Database health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
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

// Main webhook handler
app.post('/webhook', async (req, res) => {
  const { From, Body } = req.body;
  const userPhone = From;
  const userMessage = Body.trim();
  
  console.log(`📨 Received from ${userPhone}: ${userMessage}`);
  
  try {
    const session = await getSession(userPhone);
    
    // STEP 1: Initial greeting and clinic selection
    if (!session || !session.clinic_id) {
      const normalizedMessage = userMessage.toLowerCase().trim();
      
      // Check for greetings
      const greetings = ['hi', 'hello', 'start', 'hey'];
      const isGreeting = greetings.includes(normalizedMessage);
      
      if (isGreeting) {
        const clinics = await getClinics();
        
        if (clinics.length === 0) {
          await sendWhatsAppMessage(userPhone, '❌ No clinics available at the moment. Please try again later.');
          return res.sendStatus(200);
        }
        
        let clinicList = '🏥 *Welcome to Appointment Booking*\n\n';
        clinicList += '📋 Select your clinic:\n\n';
        
        clinics.forEach((clinic, index) => {
          clinicList += `${index + 1}️⃣ ${clinic.name}\n`;
        });
        
        clinicList += '\n💬 Reply with the number (e.g., 1)';
        
        await sendWhatsAppMessage(userPhone, clinicList);
        return res.sendStatus(200);
      }
      
      // Handle clinic selection by number
      const clinicNumber = parseInt(userMessage);
      
      if (isNaN(clinicNumber) || clinicNumber < 1) {
        await sendWhatsAppMessage(
          userPhone, 
          '👋 Welcome! Type *hi* to start booking an appointment.'
        );
        return res.sendStatus(200);
      }
      
      const clinics = await getClinics();
      
      if (clinicNumber > clinics.length) {
        await sendWhatsAppMessage(
          userPhone,
          `❌ Invalid selection. Please choose between 1 and ${clinics.length}.\n\nType *hi* to see the list again.`
        );
        return res.sendStatus(200);
      }
      
      const selectedClinic = clinics[clinicNumber - 1];
      
      // This sets clinic_id, current_step='clinic_selected', and temp_data with clinic_name
      await setClinicSession(userPhone, selectedClinic.id);
      
      // Update step to awaiting_name
      await pool.query(
        `UPDATE sessions SET current_step = $1, updated_at = NOW()
         WHERE user_phone = $2`,
        ['awaiting_name', userPhone]
      );
      
      await sendWhatsAppMessage(
        userPhone,
        `✅ You selected *${selectedClinic.name}*\n\n👤 Please enter your *full name*:`
      );
      
      return res.sendStatus(200);
    }
    
    // STEP 2: Collect patient name
    if (session.current_step === 'awaiting_name') {
      const name = userMessage.trim();
      
      if (name.length < 2) {
        await sendWhatsAppMessage(userPhone, '❌ Please enter a valid name (at least 2 characters).');
        return res.sendStatus(200);
      }
      
      // Update temp_data with name
      const updatedTempData = {
        ...session.temp_data,
        name: name
      };
      
      await pool.query(
        `UPDATE sessions SET current_step = $1, temp_data = $2, updated_at = NOW()
         WHERE user_phone = $3`,
        ['awaiting_date', updatedTempData, userPhone]
      );
      
      await sendWhatsAppMessage(
        userPhone,
        `📅 *Enter appointment date*\n\nFormat: DD-MM-YYYY\nExample: 20-12-2024\n\n⚠️ Date must be today or later.`
      );
      
      return res.sendStatus(200);
    }
    
    // STEP 3: Collect appointment date
    if (session.current_step === 'awaiting_date') {
      const dateRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      const match = userMessage.match(dateRegex);
      
      if (!match) {
        await sendWhatsAppMessage(
          userPhone,
          '❌ Invalid date format.\n\nUse: DD-MM-YYYY\nExample: 20-12-2024'
        );
        return res.sendStatus(200);
      }
      
      const [_, day, month, year] = match;
      const appointmentDate = `${year}-${month}-${day}`;
      
      // Validate date is not in the past
      const selectedDate = new Date(appointmentDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      if (selectedDate < today) {
        await sendWhatsAppMessage(
          userPhone,
          '❌ Cannot book appointments in the past.\n\nPlease enter a current or future date.'
        );
        return res.sendStatus(200);
      }
      
      // Update temp_data with date
      const updatedTempData = {
        ...session.temp_data,
        date: appointmentDate
      };
      
      await pool.query(
        `UPDATE sessions SET current_step = $1, temp_data = $2, updated_at = NOW()
         WHERE user_phone = $3`,
        ['awaiting_slot', updatedTempData, userPhone]
      );
      
      const availableSlots = await getAvailableSlots(session.clinic_id, appointmentDate);
      
      if (availableSlots.length === 0) {
        await sendWhatsAppMessage(
          userPhone,
          `❌ *No slots available* for ${day}-${month}-${year}\n\nType *hi* to restart and select a different date.`
        );
        await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
        return res.sendStatus(200);
      }
      
      let slotMessage = '⏰ *Available Time Slots*\n\n';
      availableSlots.forEach((slot, index) => {
        slotMessage += `${index + 1}️⃣ ${slot}\n`;
      });
      slotMessage += '\n💬 Reply with the slot number:';
      
      await sendWhatsAppMessage(userPhone, slotMessage);
      return res.sendStatus(200);
    }
    
    // STEP 4: Slot selection and booking confirmation
    if (session.current_step === 'awaiting_slot') {
      try {
        const slotNumber = parseInt(userMessage);
        const tempData = session.temp_data;
        
        const availableSlots = await getAvailableSlots(session.clinic_id, tempData.date);
        
        if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > availableSlots.length) {
          await sendWhatsAppMessage(
            userPhone,
            `❌ Invalid slot number. Please select between 1 and ${availableSlots.length}.`
          );
          return res.sendStatus(200);
        }
        
        const selectedSlot = availableSlots[slotNumber - 1];
        
        console.log(`📝 Booking: ${tempData.name} at ${selectedSlot} on ${tempData.date}`);
        
        // Save appointment to database
        const appointmentId = await saveAppointment(
          session.clinic_id,
          tempData.name,
          userPhone.replace('whatsapp:', ''),
          tempData.date,
          selectedSlot
        );
        
        console.log(`✅ Appointment saved with ID: ${appointmentId}`);
        
        // Try to notify doctor (don't break if it fails)
        try {
          await notifyDoctor(twilioClient, session.clinic_id, {
            appointmentId,
            patientName: tempData.name,
            patientPhone: userPhone.replace('whatsapp:', ''),
            date: tempData.date,
            slot: selectedSlot
          });
          console.log(`✅ Doctor notified for appointment ${appointmentId}`);
        } catch (notifyError) {
          console.error(`⚠️ Doctor notification failed:`, notifyError.message);
        }
        
        // Send confirmation to patient
        const [year, month, day] = tempData.date.split('-');
        const confirmationMessage = `✅ *Appointment Confirmed!*

🏥 *Clinic:* ${tempData.clinic_name}
👤 *Name:* ${tempData.name}
📅 *Date:* ${day}-${month}-${year}
⏰ *Time:* ${selectedSlot}

📌 *Booking ID:* #${appointmentId}

Thank you! See you soon! 👋

_Type *hi* to book another appointment._`;
        
        await sendWhatsAppMessage(userPhone, confirmationMessage);
        
        console.log(`✅ Confirmation sent to ${userPhone}`);
        
        // Clear session
        await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
        
        console.log(`✅ Booking complete - session cleared`);
        
        return res.sendStatus(200);
        
      } catch (error) {
        console.error('❌ Error in appointment booking:', error);
        
        await sendWhatsAppMessage(
          userPhone,
          '❌ Something went wrong. Please type *hi* to restart.'
        );
        
        return res.sendStatus(500);
      }
    }
    
    // Default fallback
    await sendWhatsAppMessage(
      userPhone,
      '👋 Welcome! Type *hi* to start booking an appointment.'
    );
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook Error:', error);
    
    await sendWhatsAppMessage(
      userPhone,
      '❌ Something went wrong. Please type *hi* to restart.'
    );
    
    res.sendStatus(500);
  }
});

// Helper function to send WhatsApp messages
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Clinic Bot running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-app.onrender.com/webhook`);
});
