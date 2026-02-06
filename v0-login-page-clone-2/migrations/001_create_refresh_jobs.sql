-- Create refresh_jobs table for background job tracking
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_user_id ON refresh_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_status ON refresh_jobs(status);
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_created_at ON refresh_jobs(created_at DESC);
