const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated, isOwner, isTutor } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Helper: send email
async function sendEmail(to, subject, html) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, html });
        return true;
    } catch (err) { console.error('Email failed:', err.message); return false; }
}

// ===== OWNER DASHBOARD =====
router.get('/owner', isAuthenticated, isOwner, async (req, res) => {
    try {
        const stats = {};
        stats.tutors = (await pool.query("SELECT COUNT(*) FROM users WHERE role = 'tutor' AND is_active = true")).rows[0].count;
        stats.students = (await pool.query("SELECT COUNT(*) FROM users WHERE role IN ('parent', 'student') AND is_active = true")).rows[0].count;
        stats.activeSubscriptions = (await pool.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'")).rows[0].count;
        stats.pendingApplications = (await pool.query("SELECT COUNT(*) FROM applications WHERE status = 'pending'")).rows[0].count;
        stats.openInquiries = (await pool.query("SELECT COUNT(*) FROM inquiries WHERE status = 'open'")).rows[0].count;

        const checkins = await pool.query(`SELECT c.*, u.first_name, u.last_name, u.email FROM checkins c JOIN users u ON c.student_id = u.id WHERE c.completed = false AND c.due_date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY c.due_date LIMIT 20`);
        const payments = await pool.query(`SELECT s.*, u.first_name, u.last_name, u.email, u.phone FROM subscriptions s JOIN users u ON s.parent_id = u.id WHERE s.status = 'active' AND s.next_billing_date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY s.next_billing_date LIMIT 20`);
        const inquiries = await pool.query(`SELECT * FROM inquiries WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`);
        const applications = await pool.query(`SELECT * FROM applications WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20`);
        const pendingTutors = await pool.query(`SELECT u.*, tp.subjects, tp.bio FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id WHERE u.role = 'tutor' AND tp.approved = false AND u.is_active = true`);

        res.render('admin/owner-dashboard', {
            title: 'Owner Dashboard', stats, checkins: checkins.rows,
            payments: payments.rows, inquiries: inquiries.rows, applications: applications.rows,
            pendingTutors: pendingTutors.rows, meta: {}
        });
    } catch (err) { console.error(err); req.session.error = 'Failed to load dashboard.'; res.redirect('/'); }
});

// Approve tutor
router.post('/owner/tutors/:id/approve', isAuthenticated, isOwner, async (req, res) => {
    try {
        await pool.query('UPDATE tutor_profiles SET approved = true WHERE user_id = $1', [req.params.id]);
        req.session.success = 'Tutor approved!';
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner');
});

// Generate tutor invite link
router.post('/owner/tutor-invite', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { email, subjects_for_invite } = req.body;
        const token = crypto.randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        // Handle both array (multi-select) and string (comma-separated) inputs
        let subjectsArray;
        if (Array.isArray(subjects_for_invite)) {
            subjectsArray = subjects_for_invite;
        } else if (typeof subjects_for_invite === 'string') {
            subjectsArray = subjects_for_invite.split(',').map(s => s.trim()).filter(Boolean);
        } else {
            subjectsArray = [];
        }

        await pool.query(`INSERT INTO tutor_invites (token, email, subjects, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)`,
            [token, email || null, subjectsArray, req.session.user.id, expires]);

        const baseUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const inviteUrl = `${baseUrl}/tutor-signup/${token}`;

        if (email) {
            const sent = await sendEmail(email, 'You are invited to join BrightMinds Tutoring!',
                `<h2>Welcome to BrightMinds!</h2><p>You have been invited to join as a tutor.</p><p><a href="${inviteUrl}">Click here to create your account</a></p><p>This link expires in 7 days.</p>`
            );
            if (sent) {
                req.session.success = `Invite sent to ${email}! Link: ${inviteUrl}`;
            } else {
                req.session.success = `Email could not be sent. Share this link manually: ${inviteUrl}`;
            }
        } else {
            req.session.success = `Invite link created! Share it: ${inviteUrl}`;
        }
        res.redirect('/admin/owner/tutors');
    } catch (err) { console.error(err); req.session.error = 'Failed to create invite.'; res.redirect('/admin/owner/tutors'); }
});

// Manual verify user
router.post('/owner/users/:id/verify', isAuthenticated, isOwner, async (req, res) => {
    try {
        await pool.query('UPDATE users SET email_verified = true, verify_token = NULL WHERE id = $1', [req.params.id]);
        req.session.success = 'User verified.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner/students');
});

// Admin reset user password
router.post('/owner/users/:id/reset-password', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) { req.session.error = 'Password must be at least 8 characters.'; return res.redirect('/admin/owner/students'); }
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(new_password, 12);
        await pool.query('UPDATE users SET password_hash = $1, reset_token = NULL WHERE id = $2', [hash, req.params.id]);
        req.session.success = 'Password reset.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner/students');
});

// Generate referral code
router.post('/owner/referral-code', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { discount_percent, note } = req.body;
        const code = 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await pool.query(`INSERT INTO referral_codes (code, discount_percent, created_by, note, is_active) VALUES ($1,$2,$3,$4,true)`,
            [code, parseInt(discount_percent) || 10, req.session.user.id, note || '']);
        req.session.success = `Referral code created: ${code} (${discount_percent}% off)`;
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/owner');
});

// Assign tutor to student
router.post('/owner/assign-tutor', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { tutor_id, student_id } = req.body;
        await pool.query(`INSERT INTO bookings (tutor_id, student_id, parent_id, booking_date, start_time, end_time, subject, status) VALUES ($1,$2,$2,CURRENT_DATE,'00:00','00:00','Assigned by Admin','confirmed')`, [tutor_id, student_id]);
        await pool.query('UPDATE checkins SET tutor_id = $1 WHERE student_id = $2 AND completed = false', [tutor_id, student_id]);
        req.session.success = 'Tutor assigned!';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/owner/students');
});

// Manage tutors
router.get('/owner/tutors', isAuthenticated, isOwner, async (req, res) => {
    try {
        const tutors = await pool.query(`SELECT u.*, tp.subjects, tp.approved, tp.bio, tp.experience_years, tp.tagline FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id WHERE u.role = 'tutor' ORDER BY u.first_name`);
        const invites = await pool.query(`SELECT * FROM tutor_invites WHERE used = false AND expires_at > NOW() ORDER BY created_at DESC`);
        res.render('admin/manage-tutors', { title: 'Manage Tutors', tutors: tutors.rows, invites: invites.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Manage students
router.get('/owner/students', isAuthenticated, isOwner, async (req, res) => {
    try {
        const students = await pool.query(`SELECT u.*, sp.grade_level, sp.school_name, sp.subjects_needed FROM users u LEFT JOIN student_profiles sp ON u.id = sp.user_id WHERE u.role IN ('parent', 'student') ORDER BY u.first_name`);
        const tutors = await pool.query(`SELECT u.id, u.first_name, u.last_name FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id WHERE u.role = 'tutor' AND u.is_active = true AND tp.approved = true ORDER BY u.first_name`);
        res.render('admin/manage-students', { title: 'Manage Students', students: students.rows, tutors: tutors.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Application detail
router.get('/owner/applications/:id', isAuthenticated, isOwner, async (req, res) => {
    try {
        const app = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
        if (app.rows.length === 0) { req.session.error = 'Not found.'; return res.redirect('/admin/owner'); }
        res.render('admin/application-detail', { title: 'Application Detail', application: app.rows[0], meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

router.post('/owner/applications/:id/status', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { status, reviewer_notes } = req.body;
        await pool.query(`UPDATE applications SET status = $1, reviewer_notes = $2, reviewed_at = NOW() WHERE id = $3`, [status, reviewer_notes, req.params.id]);
        req.session.success = `Application ${status}.`;
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner');
});

// Inquiry detail
router.get('/owner/inquiries/:id', isAuthenticated, isOwner, async (req, res) => {
    try {
        const inq = await pool.query('SELECT * FROM inquiries WHERE id = $1', [req.params.id]);
        if (inq.rows.length === 0) { req.session.error = 'Not found.'; return res.redirect('/admin/owner'); }
        res.render('admin/inquiry-detail', { title: 'Inquiry Detail', inquiry: inq.rows[0], meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

router.post('/owner/inquiries/:id/status', isAuthenticated, isOwner, async (req, res) => {
    try {
        await pool.query("UPDATE inquiries SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE NULL END WHERE id = $2", [req.body.status, req.params.id]);
        req.session.success = 'Inquiry updated.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner');
});

// Check-in complete
router.post('/owner/checkins/:id/complete', isAuthenticated, isOwner, async (req, res) => {
    try {
        await pool.query(`UPDATE checkins SET completed = true, completed_at = NOW(), notes = $1 WHERE id = $2`, [req.body.notes, req.params.id]);
        const c = (await pool.query('SELECT student_id, parent_id, tutor_id FROM checkins WHERE id = $1', [req.params.id])).rows[0];
        if (c) await pool.query(`INSERT INTO checkins (student_id, tutor_id, parent_id, due_date) VALUES ($1,$2,$3,CURRENT_DATE + INTERVAL '3 months')`, [c.student_id, c.tutor_id, c.parent_id]);
        req.session.success = 'Check-in completed.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/owner');
});

// Notes
router.get('/owner/notes/:userId', isAuthenticated, isOwner, async (req, res) => {
    try {
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
        const notes = await pool.query(`SELECT n.*, u.first_name as author_first, u.last_name as author_last FROM notes n JOIN users u ON n.author_id = u.id WHERE n.target_user_id = $1 ORDER BY n.is_pinned DESC, n.created_at DESC`, [req.params.userId]);
        res.render('admin/notes', { title: 'Notes', targetUser: user.rows[0], notes: notes.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

router.post('/owner/notes/:userId', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { content, is_pinned } = req.body;
        const targetUser = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.userId]);
        await pool.query(`INSERT INTO notes (author_id, target_user_id, target_type, content, is_pinned) VALUES ($1,$2,$3,$4,$5)`,
            [req.session.user.id, req.params.userId, targetUser.rows[0]?.role || 'student', content, is_pinned === 'on']);
        req.session.success = 'Note added.';
    } catch (err) { console.error(err); }
    res.redirect(`/admin/owner/notes/${req.params.userId}`);
});

// Calendar
router.get('/owner/calendar', isAuthenticated, isOwner, async (req, res) => {
    try {
        const bookings = await pool.query(`SELECT b.*, t.first_name as tutor_first, t.last_name as tutor_last, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users t ON b.tutor_id = t.id JOIN users s ON b.student_id = s.id WHERE b.booking_date >= CURRENT_DATE - INTERVAL '30 days' AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time`);
        res.render('admin/calendar', { title: 'Calendar', bookings: bookings.rows, role: 'owner', meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Blog
router.get('/owner/blog', isAuthenticated, isOwner, async (req, res) => {
    try {
        const posts = await pool.query('SELECT * FROM blog_posts ORDER BY created_at DESC');
        res.render('admin/blog-manage', { title: 'Manage Blog', posts: posts.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});
router.get('/owner/blog/new', isAuthenticated, isOwner, (req, res) => { res.render('admin/blog-edit', { title: 'New Post', post: null, meta: {} }); });
router.post('/owner/blog', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { title, excerpt, content, is_published } = req.body;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        await pool.query(`INSERT INTO blog_posts (author_id, title, slug, excerpt, content, is_published, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [req.session.user.id, title, slug, excerpt, content, is_published === 'on', is_published === 'on' ? new Date() : null]);
        req.session.success = 'Post created!';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/owner/blog');
});
router.get('/owner/blog/:id/edit', isAuthenticated, isOwner, async (req, res) => {
    try {
        const post = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [req.params.id]);
        res.render('admin/blog-edit', { title: 'Edit Post', post: post.rows[0], meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner/blog'); }
});
router.post('/owner/blog/:id', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { title, excerpt, content, is_published } = req.body;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        await pool.query(`UPDATE blog_posts SET title=$1, slug=$2, excerpt=$3, content=$4, is_published=$5, published_at = CASE WHEN $5 AND published_at IS NULL THEN NOW() ELSE published_at END, updated_at = NOW() WHERE id = $6`,
            [title, slug, excerpt, content, is_published === 'on', req.params.id]);
        req.session.success = 'Post updated!';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/owner/blog');
});
router.post('/owner/blog/:id/delete', isAuthenticated, isOwner, async (req, res) => {
    try { await pool.query('DELETE FROM blog_posts WHERE id = $1', [req.params.id]); req.session.success = 'Deleted.'; } catch (err) { console.error(err); }
    res.redirect('/admin/owner/blog');
});

// Referrals
router.get('/owner/referrals', isAuthenticated, isOwner, async (req, res) => {
    try {
        const codes = await pool.query(`SELECT rc.*, u.first_name as used_first, u.last_name as used_last FROM referral_codes rc LEFT JOIN users u ON rc.used_by = u.id ORDER BY rc.created_at DESC`);
        res.render('admin/referrals', { title: 'Referral Codes', codes: codes.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// ===== TUTOR DASHBOARD =====
router.get('/tutor', isAuthenticated, isTutor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const profile = await pool.query('SELECT * FROM tutor_profiles WHERE user_id = $1', [userId]);
        const sessions = await pool.query(`SELECT b.*, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users s ON b.student_id = s.id WHERE b.tutor_id = $1 AND b.booking_date >= CURRENT_DATE AND b.status IN ('pending','confirmed') AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time LIMIT 20`, [userId]);
        const students = await pool.query(`SELECT DISTINCT u.id, u.first_name, u.last_name, u.profile_picture, sp.grade_level FROM bookings b JOIN users u ON b.student_id = u.id LEFT JOIN student_profiles sp ON u.id = sp.user_id WHERE b.tutor_id = $1 AND b.status IN ('pending','confirmed','completed')`, [userId]);
        const unread = await pool.query('SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false', [userId]);
        const availability = await pool.query('SELECT * FROM tutor_availability WHERE tutor_id = $1 ORDER BY day_of_week, start_time', [userId]);

        res.render('admin/tutor-dashboard', {
            title: 'Tutor Dashboard', profile: profile.rows[0] || {},
            sessions: sessions.rows, students: students.rows,
            unreadCount: parseInt(unread.rows[0].count), availability: availability.rows, meta: {}
        });
    } catch (err) { console.error(err); req.session.error = 'Failed to load dashboard.'; res.redirect('/'); }
});

// Tutor profile
router.post('/tutor/profile', isAuthenticated, isTutor, upload.single('profile_picture'), async (req, res) => {
    try {
        const { bio, tagline, subjects, education, experience_years } = req.body;
        // Handle subjects from hidden input (comma separated) or multi-select (array)
        let subjectsArray;
        if (Array.isArray(subjects)) { subjectsArray = subjects; }
        else if (typeof subjects === 'string') { subjectsArray = subjects.split(',').map(s => s.trim()).filter(Boolean); }
        else { subjectsArray = []; }

        if (req.file) await pool.query('UPDATE users SET profile_picture = $1 WHERE id = $2', ['/uploads/' + req.file.filename, req.session.user.id]);
        await pool.query(`UPDATE tutor_profiles SET bio=$1, tagline=$2, subjects=$3, education=$4, experience_years=$5 WHERE user_id=$6`,
            [bio, tagline, subjectsArray, education, parseInt(experience_years) || 0, req.session.user.id]);
        req.session.success = 'Profile updated!';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/tutor');
});

// Tutor availability
router.post('/tutor/availability', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { slots } = req.body;
        const parsed = typeof slots === 'string' ? JSON.parse(slots) : (slots || []);
        await pool.query('DELETE FROM tutor_availability WHERE tutor_id = $1 AND is_recurring = true', [req.session.user.id]);
        for (const slot of parsed) {
            if (slot.start_time && slot.end_time && slot.day_of_week !== undefined) {
                await pool.query(`INSERT INTO tutor_availability (tutor_id, day_of_week, start_time, end_time, is_recurring) VALUES ($1,$2,$3,$4,true)`,
                    [req.session.user.id, parseInt(slot.day_of_week), slot.start_time, slot.end_time]);
            }
        }
        res.json({ success: true });
    } catch (err) { console.error(err); res.json({ success: false, message: err.message }); }
});

// Session sheet
router.get('/tutor/session-sheet/:bookingId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const booking = await pool.query(`SELECT b.*, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users s ON b.student_id = s.id WHERE b.id = $1 AND b.tutor_id = $2`, [req.params.bookingId, req.session.user.id]);
        const existing = await pool.query('SELECT * FROM session_sheets WHERE booking_id = $1', [req.params.bookingId]);
        res.render('admin/session-sheet', { title: 'Session Sheet', booking: booking.rows[0], sheet: existing.rows[0] || null, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/tutor'); }
});
router.post('/tutor/session-sheet/:bookingId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { topics_covered, homework_assigned, student_performance, notes, next_session_plan } = req.body;
        const booking = await pool.query('SELECT student_id FROM bookings WHERE id = $1 AND tutor_id = $2', [req.params.bookingId, req.session.user.id]);
        if (booking.rows.length === 0) { req.session.error = 'Not found.'; return res.redirect('/admin/tutor'); }
        await pool.query(`INSERT INTO session_sheets (booking_id, tutor_id, student_id, topics_covered, homework_assigned, student_performance, notes, next_session_plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (booking_id) DO UPDATE SET topics_covered=$4, homework_assigned=$5, student_performance=$6, notes=$7, next_session_plan=$8`,
            [req.params.bookingId, req.session.user.id, booking.rows[0].student_id, topics_covered, homework_assigned, student_performance, notes, next_session_plan]);
        req.session.success = 'Saved.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect('/admin/tutor');
});

// Report card
router.get('/tutor/report-card/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const student = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.studentId]);
        const reportCards = await pool.query(`SELECT * FROM report_cards WHERE student_id = $1 AND tutor_id = $2 ORDER BY report_date DESC`, [req.params.studentId, req.session.user.id]);
        res.render('admin/report-card', { title: 'Report Card', student: student.rows[0], reportCards: reportCards.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/tutor'); }
});
router.post('/tutor/report-card/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { term, overall_grade, subjects_json, attendance_score, participation_score, homework_score, comments, strengths, areas_for_improvement, goals_next_term } = req.body;
        await pool.query(`INSERT INTO report_cards (tutor_id, student_id, term, report_date, overall_grade, subjects, attendance_score, participation_score, homework_score, comments, strengths, areas_for_improvement, goals_next_term) VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [req.session.user.id, req.params.studentId, term, overall_grade, subjects_json || '[]', parseInt(attendance_score), parseInt(participation_score), parseInt(homework_score), comments, strengths, areas_for_improvement, goals_next_term]);
        req.session.success = 'Report card created.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect(`/admin/tutor/report-card/${req.params.studentId}`);
});

// Tutor notes
router.post('/tutor/notes/:studentId', isAuthenticated, isTutor, async (req, res) => {
    try {
        await pool.query(`INSERT INTO notes (author_id, target_user_id, target_type, content) VALUES ($1,$2,'student',$3)`, [req.session.user.id, req.params.studentId, req.body.content]);
        req.session.success = 'Note added.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/tutor');
});

// Tutor calendar
router.get('/tutor/calendar', isAuthenticated, isTutor, async (req, res) => {
    try {
        const bookings = await pool.query(`SELECT b.*, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users s ON b.student_id = s.id WHERE b.tutor_id = $1 AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days' AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time`, [req.session.user.id]);
        const availability = await pool.query('SELECT * FROM tutor_availability WHERE tutor_id = $1 ORDER BY day_of_week, start_time', [req.session.user.id]);
        res.render('admin/calendar', { title: 'My Calendar', bookings: bookings.rows, availability: availability.rows, role: 'tutor', meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/tutor'); }
});

module.exports = router;
