async function handleBooking(userPhone, clinicId, session, message, twiml) {
    const text = message.trim().toLowerCase();

    // normalize human replies
    const normalized =
        ['1', 'ok', 'okay', 'yes', 'start'].includes(text) ? '1' : text;

    console.log('📋 Booking stage:', session.current_step, 'Message:', normalized);

    switch (session.current_step) {

        case 'booking_start':
            await SessionManager.updateSession(userPhone, clinicId, {
                current_step: 'booking_name'
            });
            twiml.message('Please enter patient name:');
            return;

        case 'booking_name':
            session.temp_data.patientName = message;
            await SessionManager.updateSession(userPhone, clinicId, {
                current_step: 'booking_date',
                temp_data: session.temp_data
            });
            twiml.message('Enter appointment date (YYYY-MM-DD):');
            return;

        case 'booking_date':
            session.temp_data.appointmentDate = message;
            await SessionManager.updateSession(userPhone, clinicId, {
                current_step: 'booking_time',
                temp_data: session.temp_data
            });
            twiml.message('Enter appointment time (HH:MM):');
            return;

        case 'booking_time':
            session.temp_data.appointmentTime = message;
            await SessionManager.updateSession(userPhone, clinicId, {
                current_step: 'booking_confirm',
                temp_data: session.temp_data
            });
            twiml.message(
                `Confirm appointment?\n\n` +
                `Name: ${session.temp_data.patientName}\n` +
                `Date: ${session.temp_data.appointmentDate}\n` +
                `Time: ${session.temp_data.appointmentTime}\n\n` +
                `Reply YES to confirm or NO to cancel`
            );
            return;

        case 'booking_confirm':
            if (text === 'yes') {
                await finalizeAppointment({
                    clinicId,
                    customerId: session.customer_id,
                    patientPhone: userPhone,
                    appointmentDate: session.temp_data.appointmentDate,
                    appointmentTime: session.temp_data.appointmentTime
                });

                await SessionManager.updateSession(userPhone, clinicId, {
                    current_step: 'main_menu',
                    temp_data: {}
                });

                twiml.message('✅ Appointment booked successfully.');
            } else {
                await SessionManager.updateSession(userPhone, clinicId, {
                    current_step: 'main_menu',
                    temp_data: {}
                });
                twiml.message('❌ Booking cancelled.');
            }
            return;

        default:
            twiml.message('Reply 1 to book an appointment.');
            return;
    }
}
