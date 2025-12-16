require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const pool = require('./db');
const { getClinics, setClinicSession, getSession } = require('./handlers/clinicSelection');
const { saveAppointment, getAvailableSlots } = require('./handlers/appointmentBooking');
const { notifyDoctor } = require('./handlers/notifications');

const app = express();
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Health check
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Clinic Bot is running');
});

// Main webhook
app.post('/webhook', async (req, res) => {
  const { From, Body } = req.body;
  const userPhone = From;
  const userMessage = Body.trim().toLowerCase();
  
  try {
    const session = await getSession(userPhone);
    
    // STEP 1: Clinic Selection
    if (!session || !session.clinic_id) {
      if (userMessage === 'hi' || userMessage === 'hello' || userMessage === 'start') {
        const clinics = await getClinics();
        let clinicList = '🏥 *Welcome to Appointment Booking*\n\nSelect your clinic:\n\n';
        clinics.forEach((clinic, index) => {
          clinicList += `${index + 1}️⃣ ${clinic.name}\n`;
        });
        clinicList += '\nReply with the number (e.g., 1)';
        
        await sendWhatsAppMessage(userPhone, clinicList);
        return res.sendStatus(200);
      }
      
      // Handle clinic selection
      const clinicNumber = parseInt(userMessage);
      if (clinicNumber > 0) {
        const clinics = await getClinics();
        if (clinicNumber <= clinics.length) {
          const selectedClinic = clinics[clinicNumber - 1];
          await setClinicSession(userPhone, selectedClinic.id);
          
          await sendWhatsAppMessage(
            userPhone,
            `✅ You selected *${selectedClinic.name}*\n\nPlease enter your full name:`
          );
          
          await pool.query(
            `UPDATE sessions SET current_step = 'awaiting_name', 
             temp_data = jsonb_build_object('clinic_name', $1)
             WHERE user_phone = $2`,
            [selectedClinic.name, userPhone]
          );
          
          return res.sendStatus(200);
        }
      }
      
      await sendWhatsAppMessage(userPhone, '❌ Invalid selection. Type "hi" to start.');
      return res.sendStatus(200);
    }
    
    // STEP 2: Name Collection
    if (session.current_step === 'awaiting_name') {
      await pool.query(
        `UPDATE sessions SET current_step = 'awaiting_date',
         temp_data = temp_data || jsonb_build_object('name', $1)
         WHERE user_phone = $2`,
        [Body.trim(), userPhone]
      );
      
      await sendWhatsAppMessage(
        userPhone,
        '📅 Please enter appointment date (DD-MM-YYYY):\n\nExample: 20-12-2024'
      );
      return res.sendStatus(200);
    }
    
    // STEP 3: Date Collection
    if (session.current_step === 'awaiting_date') {
      const dateRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      const match = Body.trim().match(dateRegex);
      
      if (!match) {
        await sendWhatsAppMessage(userPhone, '❌ Invalid format. Use DD-MM-YYYY (e.g., 20-12-2024)');
        return res.sendStatus(200);
      }
      
      const [_, day, month, year] = match;
      const appointmentDate = `${year}-${month}-${day}`;
      
      await pool.query(
        `UPDATE sessions SET current_step = 'awaiting_slot',
         temp_data = temp_data || jsonb_build_object('date', $1)
         WHERE user_phone = $2`,
        [appointmentDate, userPhone]
      );
      
      const availableSlots = await getAvailableSlots(session.clinic_id, appointmentDate);
      
      if (availableSlots.length === 0) {
        await sendWhatsAppMessage(userPhone, '❌ No slots available for this date. Type "hi" to restart.');
        await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
        return res.sendStatus(200);
      }
      
      let slotMessage = '⏰ *Available Time Slots:*\n\n';
      availableSlots.forEach((slot, index) => {
        slotMessage += `${index + 1}️⃣ ${slot}\n`;
      });
      slotMessage += '\nReply with the number:';
      
      await sendWhatsAppMessage(userPhone, slotMessage);
      return res.sendStatus(200);
    }
    
    // STEP 4: Slot Selection & Booking
    if (session.current_step === 'awaiting_slot') {
      const slotNumber = parseInt(userMessage);
      const tempData = session.temp_data;
      const availableSlots = await getAvailableSlots(session.clinic_id, tempData.date);
      
      if (slotNumber < 1 || slotNumber > availableSlots.length) {
        await sendWhatsAppMessage(userPhone, '❌ Invalid slot. Please select a valid number.');
        return res.sendStatus(200);
      }
      
      const selectedSlot = availableSlots[slotNumber - 1];
      
      // Save appointment
      const appointmentId = await saveAppointment(
        session.clinic_id,
        tempData.name,
        userPhone.replace('whatsapp:', ''),
        tempData.date,
        selectedSlot
      );
      
      // Notify doctor
      await notifyDoctor(twilioClient, session.clinic_id, {
        appointmentId,
        patientName: tempData.name,
        patientPhone: userPhone.replace('whatsapp:', ''),
        date: tempData.date,
        slot: selectedSlot
      });
      
      // Confirm to patient
      const [year, month, day] = tempData.date.split('-');
      await sendWhatsAppMessage(
        userPhone,
        `✅ *Appointment Confirmed!*\n\n🏥 Clinic: ${tempData.clinic_name}\n📅 Date: ${day}-${month}-${year}\n⏰ Time: ${selectedSlot}\n\nBooking ID: #${appointmentId}\n\nSee you soon! 👋`
      );
      
      // Clear session
      await pool.query('DELETE FROM sessions WHERE user_phone = $1', [userPhone]);
      return res.sendStatus(200);
    }
    
    await sendWhatsAppMessage(userPhone, 'Type "hi" to start booking.');
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Error:', error);
    await sendWhatsAppMessage(userPhone, '❌ Something went wrong. Type "hi" to restart.');
    res.sendStatus(500);
  }
});

async function sendWhatsAppMessage(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: to,
    body: body
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});