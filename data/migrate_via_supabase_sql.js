require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function migrate() {
  console.log('Starting migration: Add status and participant_count to bookings table...');
  
  try {
    // Cek apakah kolom status sudah ada
    const { data: existingData, error: checkError } = await supabase
      .from('bookings')
      .select('status')
      .limit(1);
    
    if (checkError && checkError.code === 'PGRST204') {
      console.log('Column status does not exist. Please add it manually via Supabase SQL Editor:');
      console.log('ALTER TABLE bookings ADD COLUMN status TEXT DEFAULT \'pending\';');
      console.log('ALTER TABLE bookings ADD COLUMN participant_count INTEGER;');
      console.log('UPDATE bookings SET status = \'approved\' WHERE status IS NULL;');
      return;
    }
    
    if (checkError) {
      console.error('Error checking status column:', checkError);
      return;
    }
    
    console.log('Columns appear to exist already');
    
    // Update existing bookings to have 'approved' status
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'approved' })
      .is('status', null);
    
    if (updateError) {
      console.error('Error updating existing bookings:', updateError);
    } else {
      console.log('Existing bookings updated to approved status');
    }

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
  }
}

migrate();