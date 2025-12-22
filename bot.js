
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const SessionManager = require('./utils/sessionManager');
const ClinicSelection = require('./handlers/clinicSelection');
const { handleBooking } = require('./handlers/appointmentBooking');
const { handleDoctorCommands } = require('./handlers/doctorCommands');
const { handlePatientCancellation } = require('./handlers/patientCancellation');
const PatientCommandsHandler = require('./handlers/patientCommands');
const LanguageHandler = require('./handlers/languageHandler');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const to = req.body.To;
    const message = (req.body.Body || '').trim();

    console.log('📨 Incoming:', { from, to, message });

    if (!from || !message) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 1. Clinic lookup (WABA based)
    const clinic = await ClinicSelection.getClinicByWaba(to);
    if (!clinic) {
      twiml.message('❌ Clinic not found.');
      return res.type('text/xml').send(twiml.toString());
    }

    const clinicId = clinic.id;

    // 2. Load or create session
    let session = await SessionManager.getSession(from, clinicId);
    if (!session) {
      session = await SessionManager.createSession(from, clinicId);
    }

    console.log('📍 Current step:', session.current_step);

    // 3. Doctor commands
    if (await handleDoctorCommands(from, clinicId, message, twiml)) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 4. Patient cancellation
    if (await handlePatientCancellation(from, clinicId, message, twiml)) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 5. Patient commands
    if (PatientCommandsHandler.isPatientCommand(message)) {
      const result = await PatientCommandsHandler.handleCommand(from, clinicId, message);
      if (result?.message) twiml.message(result.message);
      return res.type('text/xml').send(twiml.toString());
    }

    // 6. Language / greeting
    if (await LanguageHandler.handle(from, message, twiml)) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 7. Appointment booking flow
    await handleBooking(from, clinicId, session, message, twiml);

    return res.type('text/xml').send(twiml.toString());

  } catch (err) {
    console.error('❌ Webhook error:', err);
    twiml.message('❌ Something went wrong. Type *hi* to restart.');
    return res.type('text/xml').send(twiml.toString());
  }
});

app.get('/', (_, res) => res.send('✅ WhatsApp Clinic Bot Running'));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
