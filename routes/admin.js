const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated, isOwner, isTutor, isOwnerOrTutor } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ===== OWNER DASHBOARD =====
router.get('/owner', isAuthenticated, isOwner, async (req, res) => {
    try {
        const stats = {};

        const tutorCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'tutor' AND is_active = true");
        stats.tutors = tutorCount.rows[0].count;

        const studentCount = await pool.query("SELECT COUNT(*) FROM users WHERE role IN ('parent', 'student') AND is_active = true");
        stats.students = studentCount.rows[0].count;

        const activeSubCount = await pool.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'");
        stats.activeSubscriptions = activeSubCount.rows[0].count;

        const pendingApps = await pool.query("SELECT COUNT(*) FROM applications WHERE status = 'pending'");
        stats.pendingApplications = pendingApps.rows[0].count;

        // Upcoming check-ins
        const checkins = await pool.query(`
            SELECT c.*, u.first_name, u.last_name, u.email
            FROM checkins c
            JOIN users u ON c.student_id = u.id
            WHERE c.completed = false
            AND c.due_date <= CURRENT_DATE + INTERVAL '7 days'
            ORDER BY c.due_date
            LIMIT 20
        `);

        // Payment reminders
        const payments = await pool.query(`
            SELECT s.*, u.first_name, u.last_name, u.email, u.phone
            FROM subscriptions s
            JOIN users u ON s.parent_id = u.id
            WHERE s.status = 'active'
            AND s.next_billing_date <= CURRENT_DATE + INTERVAL '7 days'
            ORDER BY s.next_billing_date
            LIMIT 20
        `);

        // Recent inquiries
        const inquiries = await pool.query(`
            SELECT * FROM inquiries WHERE status = 'open' ORDER BY created_at DESC LIMIT 10
        `);

        // Pending applications
        const applications = await pool.query(`
            SELECT * FROM applications WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10
        `);

        res.render('admin/owner-dashboard', {
            title: 'Owner Dashboard - BrightMinds',
            stats,
            checkins: checkins.rows,
            payments: payments.rows,
            inquiries: inquiries.rows,
            applications: applications.rows,
            meta: {}
        });
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to load dashboard.';
        res.redirect('/');
    }
});

// Owner - Manage tutors
router.get('/owner/tutors', isAuthenticated, isOwner, async (req, res) => {
    try {
        const tutors = await pool.query(`
            SELECT u.*, tp.subjects, tp.approved, tp.bio, tp.experience_years
            FROM users u
            JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.role = 'tutor'
            ORDER BY u.first_name
        `);
        res.render('admin/manage-tutors', { title: 'Manage Tutors', tutors: tutors.rows, meta: {} });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

// Owner - Manage students
router.get('/owner/students', isAuthenticated, isOwner, async (req, res) => {
    try {
        const students = await pool.query(`
            SELECT u.*, sp.grade_level, sp.school_name, sp.subjects_needed
            FROM users u
            LEFT JOIN student_profiles sp ON u.id = sp.user_id
            WHERE u.role IN ('parent', 'student')
            ORDER BY u.first_name
        `);
        res.render('admin/manage-students', { title: 'Manage Students', students: students.rows, meta: {} });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

// Owner - Notes on users
router.get('/owner/notes/:userId', isAuthenticated, isOwner, async (req, res) => {
    try {
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
        const notes = await pool.query(`
            SELECT n.*, u.first_name as author_first, u.last_name as author_last
            FROM notes n
            JOIN users u ON n.author_id = u.id
            WHERE n.target_user_id = $1
            ORDER BY n.is_pinned DESC, n.created_at DESC
        `, [req.params.userId]);

        res.render('admin/notes', {
            title: 'Notes',
            targetUser: user.rows[0],
            notes: notes.rows,
            meta: {}
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

router.post('/owner/notes/:userId', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { content, is_pinned } = req.body;
        const targetUser = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.userId]);
        await pool.query(`
            INSERT INTO notes (author_id, target_user_id, target_type, content, is_pinned)
            VALUES ($1, $2, $3, $4, $5)
        `, [req.session.user.id, req.params.userId, targetUser.rows[0]?.role || 'student', content, is_pinned === 'on']);

        req.session.success = 'Note added.';
        res.redirect(`/admin/owner/notes/${req.params.userId}`);
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to add note.';
        res.redirect(`/admin/owner/notes/${req.params.userId}`);
    }
});

// Owner - Applications
router.post('/owner/applications/:id/status', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { status, reviewer_notes } = req.body;
        await pool.query(`
            UPDATE applications SET status = $1, reviewer_notes = $2, reviewed_at = NOW()
            WHERE id = $3
        `, [status, reviewer_notes, req.params.id]);

        // If accepted as tutor, create user account
        if (status === 'accepted') {
            const app = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
            const a = app.rows[0];
            if (a.applicant_type === 'tutor') {
                const bcrypt = require('bcryptjs');
                const crypto = require('crypto');
                const tempPass = crypto.randomBytes(8).toString('hex');
                const hash = await bcrypt.hash(tempPass, 12);
                const refCode = 'BM' + crypto.randomBytes(4).toString('hex').toUpperCase();

                const newUser = await pool.query(`
                    INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code)
                    VALUES ($1, $2, 'tutor', $3, $4, $5, $6)
                    ON CONFLICT (email) DO NOTHING
                    RETURNING id
                `, [a.email, hash, a.first_name, a.last_name, a.phone, refCode]);

                if (newUser.rows.length > 0) {
                    await pool.query(`
                        INSERT INTO tutor_profiles (user_id, subjects, education, experience_years)
                        VALUES ($1, $2, $3, 0)
                    `, [newUser.rows[0].id, a.subjects || [], a.education]);
                }
                // Would email temporary password here
            }
        }

        req.session.success = `Application ${status}.`;
        res.redirect('/admin/owner');
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to update application.';
        res.redirect('/admin/owner');
    }
});

// Owner - Inquiries management
router.post('/owner/inquiries/:id/status', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE inquiries SET status = $1, resolved_at = CASE WHEN $1 = \'resolved\' THEN NOW() ELSE NULL END WHERE id = $2', [status, req.params.id]);
        req.session.success = 'Inquiry updated.';
        res.redirect('/admin/owner');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

// Owner - Check-in completion
router.post('/owner/checkins/:id/complete', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { notes } = req.body;
        await pool.query(`
            UPDATE checkins SET completed = true, completed_at = NOW(), notes = $1 WHERE id = $2
        `, [notes, req.params.id]);

        // Schedule next check-in
        const checkin = await pool.query('SELECT student_id, parent_id, tutor_id FROM checkins WHERE id = $1', [req.params.id]);
        const c = checkin.rows[0];
        await pool.query(`
            INSERT INTO checkins (student_id, tutor_id, parent_id, due_date)
            VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '3 months')
        `, [c.student_id, c.tutor_id, c.parent_id]);

        req.session.success = 'Check-in completed. Next check-in scheduled.';
        res.redirect('/admin/owner');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

// Owner calendar
router.get('/owner/calendar', isAuthenticated, isOwner, async (req, res) => {
    try {
        const bookings = await pool.query(`
            SELECT b.*,
                   t.first_name as tutor_first, t.last_name as tutor_last,
                   s.first_name as student_first, s.last_name as student_last
            FROM bookings b
            JOIN users t ON b.tutor_id = t.id
            JOIN users s ON b.student_id = s.id
            WHERE b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY b.booking_date, b.start_time
        `);
        res.render('admin/calendar', {
            title: 'Calendar - Owner Dashboard',
            bookings: bookings.rows,
            role: 'owner',
            meta: {}
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/owner');
    }
});

// ===== TUTOR DASHBOARD =====
router.get('/tutor', isAuthenticated, isTutor, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // Get tutor profile
        const profile = await pool.query('SELECT * FROM tutor_profiles WHERE user_id = $1', [userId]);

        // Upcoming sessions
        const sessions = await pool.query(`
            SELECT b.*, s.first_name as student_first, s.last_name as student_last
            FROM bookings b
            JOIN users s ON b.student_id = s.id
            WHERE b.tutor_id = $1 AND b.booking_date >= CURRENT_DATE AND b.status IN ('pending', 'confirmed')
            ORDER BY b.booking_date, b.start_time
            LIMIT 20
        `, [userId]);

        // Students assigned
        const students = await pool.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.profile_picture, sp.grade_level
            FROM bookings b
            JOIN users u ON b.student_id = u.id
            LEFT JOIN student_profiles sp ON u.id = sp.user_id
            WHERE b.tutor_id = $1 AND b.status IN ('pending', 'confirmed', 'completed')
        `, [userId]);

        // Unread messages
        const unread = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false',
            [userId]
        );

        res.render('admin/tutor-dashboard', {
            title: 'Tutor Dashboard - BrightMinds',
            profile: profile.rows[0] || {},
            sessions: sessions.rows,
            students: students.rows,
            unreadCount: parseInt(unread.rows[0].count),
            meta: {}
        });
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to load dashboard.';
        res.redirect('/');
    }
});

// Tutor - Update profile
router.post('/tutor/profile', isAuthenticated, isTutor, upload.single('profile_picture'), async (req, res) => {
    try {
        const { bio, tagline, subjects, education, experience_years } = req.body;
        const subjectsArray = subjects ? subjects.split(',').map(s => s.trim()) : [];

        if (req.file) {
            await pool.query('UPDATE users SET profile_picture = $1 WHERE id = $2',
                ['/uploads/' + req.file.filename, req.session.user.id]);
        }

        await pool.query(`
            UPDATE tutor_profiles
            SET bio = $1, tagline = $2, subjects = $3, education = $4, experience_years = $5
            WHERE user_id = $6
        `, [bio, tagline, subjectsArray, education, parseInt(experience_years) || 0, req.session.user.id]);

        req.session.success = 'Profile updated!';
        res.redirect('/admin/tutor');
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to update profile.';
        res.redirect('/admin/tutor');
    }
});

// Tutor - Set availability
router.post('/tutor/availability', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { slots } = req.body; // JSON array of { day_of_week, start_time, end_time }
        const parsed = typeof slots === 'string' ? JSON.parse(slots) : slots;

        // Clear existing recurring availability
        await pool.query('DELETE FROM tutor_availability WHERE tutor_id = $1 AND is_recurring = true', [req.session.user.id]);

        // Insert new slots
        for (const slot of parsed) {
            await pool.query(`
                INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time, is_recurring)
                VALUES ($1, $2, $3, $4, true)
            `, [req.session.user.id, slot.day_of_week, slot.start_time, slot.end_time]);
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Failed to update availability.' });
    }
});

// Tutor - Session sheet
router.get('/tutor/session-sheet/:bookingId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const booking = await pool.query(`
            SELECT b.*, s.first_name as student_first, s.last_name as student_last
            FROM bookings b
            JOIN users s ON b.student_id = s.id
            WHERE b.id = $1 AND b.tutor_id = $2
        `, [req.params.bookingId, req.session.user.id]);

        const existing = await pool.query('SELECT * FROM session_sheets WHERE booking_id = $1', [req.params.bookingId]);

        res.render('admin/session-sheet', {
            title: 'Session Sheet',
            booking: booking.rows[0],
            sheet: existing.rows[0] || null,
            meta: {}
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/tutor');
    }
});

router.post('/tutor/session-sheet/:bookingId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { topics_covered, homework_assigned, student_performance, notes, next_session_plan } = req.body;
        const booking = await pool.query('SELECT student_id FROM bookings WHERE id = $1 AND tutor_id = $2', [req.params.bookingId, req.session.user.id]);

        if (booking.rows.length === 0) {
            req.session.error = 'Booking not found.';
            return res.redirect('/admin/tutor');
        }

        await pool.query(`
            INSERT INTO session_sheets (booking_id, tutor_id, student_id, topics_covered, homework_assigned, student_performance, notes, next_session_plan)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (booking_id) DO UPDATE SET
                topics_covered = $4, homework_assigned = $5, student_performance = $6, notes = $7, next_session_plan = $8
        `, [req.params.bookingId, req.session.user.id, booking.rows[0].student_id, topics_covered, homework_assigned, student_performance, notes, next_session_plan]);

        req.session.success = 'Session sheet saved.';
        res.redirect('/admin/tutor');
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to save session sheet.';
        res.redirect('/admin/tutor');
    }
});

// Tutor - Report card
router.get('/tutor/report-card/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const student = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.studentId]);
        const reportCards = await pool.query(`
            SELECT * FROM report_cards
            WHERE student_id = $1 AND tutor_id = $2
            ORDER BY report_date DESC
        `, [req.params.studentId, req.session.user.id]);

        res.render('admin/report-card', {
            title: 'Report Card',
            student: student.rows[0],
            reportCards: reportCards.rows,
            meta: {}
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/tutor');
    }
});

router.post('/tutor/report-card/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const {
            term, overall_grade, subjects_json, attendance_score,
            participation_score, homework_score, comments,
            strengths, areas_for_improvement, goals_next_term
        } = req.body;

        await pool.query(`
            INSERT INTO report_cards (tutor_id, student_id, term, report_date, overall_grade, subjects,
                attendance_score, participation_score, homework_score, comments, strengths,
                areas_for_improvement, goals_next_term)
            VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            req.session.user.id, req.params.studentId, term, overall_grade,
            subjects_json || '[]', parseInt(attendance_score), parseInt(participation_score),
            parseInt(homework_score), comments, strengths, areas_for_improvement, goals_next_term
        ]);

        req.session.success = 'Report card created.';
        res.redirect(`/admin/tutor/report-card/${req.params.studentId}`);
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to create report card.';
        res.redirect('/admin/tutor');
    }
});

// Tutor - Notes
router.post('/tutor/notes/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { content } = req.body;
        await pool.query(`
            INSERT INTO notes (author_id, target_user_id, target_type, content)
            VALUES ($1, $2, 'student', $3)
        `, [req.session.user.id, req.params.studentId, content]);
        req.session.success = 'Note added.';
        res.redirect(`/admin/tutor`);
    } catch (err) {
        console.error(err);
        res.redirect('/admin/tutor');
    }
});

// Tutor calendar
router.get('/tutor/calendar', isAuthenticated, isTutor, async (req, res) => {
    try {
        const bookings = await pool.query(`
            SELECT b.*,
                   s.first_name as student_first, s.last_name as student_last
            FROM bookings b
            JOIN users s ON b.student_id = s.id
            WHERE b.tutor_id = $1 AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY b.booking_date, b.start_time
        `, [req.session.user.id]);

        const availability = await pool.query(`
            SELECT * FROM tutor_availability WHERE tutor_id = $1 ORDER BY day_of_week, start_time
        `, [req.session.user.id]);

        res.render('admin/calendar', {
            title: 'My Calendar - Tutor Dashboard',
            bookings: bookings.rows,
            availability: availability.rows,
            role: 'tutor',
            meta: {}
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/tutor');
    }
});

module.exports = router;
