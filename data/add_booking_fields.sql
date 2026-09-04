-- Add status and participant_count fields to bookings table
ALTER TABLE bookings 
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS participant_count INTEGER;

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- Update existing bookings to have 'approved' status by default
UPDATE bookings SET status = 'approved' WHERE status IS NULL;