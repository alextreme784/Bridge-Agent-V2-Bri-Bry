-- Job tracking: hours worked, task checklist, and notes per transaction
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS job_hours NUMERIC(6,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS job_tasks JSONB DEFAULT '[]';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS job_notes TEXT;
