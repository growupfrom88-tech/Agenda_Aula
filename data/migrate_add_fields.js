require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function migrate() {
  console.log('Starting migration: Add status and participant_count to bookings table...');
  
  try {
    // Add status column
    const { error: statusError } = await supabase.rpc('exec_sql', {
      sql: "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'"
    });
    
    if (statusError && !statusError.message.includes('already exists')) {
      console.error('Error adding status column:', statusError);
    } else {
      console.log('Status column added or already exists');
    }

    // Add participant_count column
    const { error: participantError } = await supabase.rpc('exec_sql', {
      sql: "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS participant_count INTEGER"
    });
    
    if (participantError && !participantError.message.includes('already exists')) {
      console.error('Error adding participant_count column:', participantError);
    } else {
      console.log('Participant_count column added or already exists');
    }

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
    process.exit(1);
  }
}

migrate();