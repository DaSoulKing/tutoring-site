-- V18 Migration - Run EACH block separately in Railway PostgreSQL > Data > Query

-- 1. Audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(200) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Attendance and recurring on bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attendance VARCHAR(20) DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS makeup_deadline DATE DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_recurring_booking BOOLEAN DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurring_day INTEGER DEFAULT NULL;

-- 3. Subscription enhancements
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS sessions_per_month INTEGER DEFAULT 4;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rate_total DECIMAL(10,2) DEFAULT NULL;

-- 4. Payment status on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'unpaid';

-- 5. Message monitoring flag
ALTER TABLE messages ADD COLUMN IF NOT EXISTS admin_visible BOOLEAN DEFAULT true;

-- 6. Site settings (if not created yet)
CREATE TABLE IF NOT EXISTS site_settings (
    "key" VARCHAR(100) PRIMARY KEY,
    "value" TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO site_settings ("key", "value") VALUES
    ('stat_satisfaction', '97%'),
    ('stat_satisfaction_label', 'Student Satisfaction'),
    ('stat_students', '500+'),
    ('stat_students_label', 'Students Helped'),
    ('stat_tutors', '50+'),
    ('stat_tutors_label', 'Expert Tutors'),
    ('stat_improvement', '92%'),
    ('stat_improvement_label', 'Grade Improvement')
ON CONFLICT ("key") DO NOTHING;

-- 7. Set owner and tutors as paid by default
UPDATE users SET payment_status = 'paid' WHERE role IN ('owner', 'tutor');
