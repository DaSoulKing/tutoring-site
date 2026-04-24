const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated, isOwner, isTutor } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

// Validate integer params on all admin routes
router.param('id', (req, res, next, val) => {
    if (!/^\d+$/.test(val)) return res.status(400).render('error', { title: '400', message: 'Invalid request.', code: 400 });
    next();
});
router.param('userId', (req, res, next, val) => {
    if (!/^\d+$/.test(val)) return res.status(400).render('error', { title: '400', message: 'Invalid request.', code: 400 });
    next();
});
router.param('bookingId', (req, res, next, val) => {
    if (!/^\d+$/.test(val)) return res.status(400).render('error', { title: '400', message: 'Invalid request.', code: 400 });
    next();
});
router.param('studentId', (req, res, next, val) => {
    if (!/^\d+$/.test(val)) return res.status(400).render('error', { title: '400', message: 'Invalid request.', code: 400 });
    next();
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => {
        // Generate random filename to prevent path traversal and info leakage
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
});
const allowedImageMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        // Only allow images for profile pictures
        if (file.fieldname === 'profile_picture') {
            return cb(null, allowedImageMimes.includes(file.mimetype));
        }
        // For resumes, check extension
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, ['.pdf', '.doc', '.docx'].includes(ext));
    }
});

// Helper: send email (centralized)
const { sendEmail, testEmail } = require('../utils/email');

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
        const unverifiedAccounts = await pool.query(`SELECT id, first_name, last_name, email, role, created_at FROM users WHERE email_verified = false AND role != 'owner' AND is_active = true ORDER BY created_at DESC`);

        const testVideoUrl = req.session.testVideoUrl; delete req.session.testVideoUrl;
        const testVideoRoom = req.session.testVideoRoom; delete req.session.testVideoRoom;

        res.render('admin/owner-dashboard', {
            title: 'Owner Dashboard', stats, checkins: checkins.rows,
            payments: payments.rows, inquiries: inquiries.rows, applications: applications.rows,
            pendingTutors: pendingTutors.rows, unverifiedAccounts: unverifiedAccounts.rows,
            testVideoUrl, testVideoRoom, meta: {}
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
            const siteName = process.env.SITE_NAME || 'BrainBridge';
            await sendEmail(email, 'You are invited to join ' + siteName + '!',
                '<h2>Welcome to ' + siteName + '!</h2><p>You have been invited to join as a tutor.</p><p><a href="' + inviteUrl + '">Click here to create your account</a></p><p>This link expires in 7 days.</p>'
            );
            // Always show link since Resend test sender may not deliver
            req.session.success = `Invite created for ${email}! Share this link: ${inviteUrl}`;
        } else {
            req.session.success = `Invite link created! Share it: ${inviteUrl}`;
        }
        res.redirect('/admin/owner/tutors');
    } catch (err) { console.error(err); req.session.error = 'Failed to create invite.'; res.redirect('/admin/owner/tutors'); }
});

// Approve (verify) user account
router.post('/owner/users/:id/verify', isAuthenticated, isOwner, async (req, res) => {
    try {
        const target = await pool.query('SELECT first_name, last_name, email FROM users WHERE id = $1', [req.params.id]);
        await pool.query('UPDATE users SET email_verified = true, verify_token = NULL WHERE id = $1', [req.params.id]);
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'account_approved', target.rows[0] ? (target.rows[0].first_name + ' ' + target.rows[0].last_name + ' (' + target.rows[0].email + ')') : 'User ' + req.params.id]); } catch(e) {}
        req.session.success = 'Account approved!';
    } catch (err) { console.error(err); }
    res.redirect(req.headers.referer || '/admin/owner');
});

// Delete user account (destructive)
router.post('/owner/users/:id/delete', isAuthenticated, isOwner, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        // Don't allow deleting the owner
        const target = await pool.query('SELECT role, email_verified, first_name, last_name, email FROM users WHERE id = $1', [userId]);
        if (target.rows.length === 0) { req.session.error = 'User not found.'; return res.redirect('/admin/owner'); }
        if (target.rows[0].role === 'owner') { req.session.error = 'Cannot delete owner account.'; return res.redirect('/admin/owner'); }
        var targetName = target.rows[0].first_name + ' ' + target.rows[0].last_name + ' (' + target.rows[0].email + ')';

        // Delete related data first
        await pool.query('DELETE FROM notes WHERE target_user_id = $1 OR author_id = $1', [userId]);
        await pool.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [userId]);
        await pool.query('DELETE FROM bookings WHERE student_id = $1 OR parent_id = $1 OR tutor_id = $1', [userId]);
        await pool.query('DELETE FROM checkins WHERE student_id = $1', [userId]);
        await pool.query('DELETE FROM tutor_availability WHERE tutor_id = $1', [userId]);
        await pool.query('DELETE FROM tutor_profiles WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM student_profiles WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM subscriptions WHERE parent_id = $1', [userId]);
        await pool.query('DELETE FROM report_cards WHERE student_id = $1 OR tutor_id = $1', [userId]);
        await pool.query('DELETE FROM session_sheets WHERE tutor_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);

        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'account_deleted', targetName]); } catch(e) {}
        req.session.success = 'Account deleted.';
    } catch (err) { console.error(err); req.session.error = 'Failed to delete. ' + err.message; }
    res.redirect(req.headers.referer || '/admin/owner');
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

// Test email (admin only)
router.post('/owner/test-email', isAuthenticated, isOwner, async (req, res) => {
    const to = req.body.email || req.session.user.email;
    const result = await testEmail(to);
    req.session[result ? 'success' : 'error'] = result
        ? `Test email sent to ${to}! Check your inbox.`
        : 'Email failed. Check Railway logs for details. Consider using Resend API instead of SMTP.';
    res.redirect('/admin/owner');
});

// Test video call
router.post('/owner/test-video', isAuthenticated, isOwner, async (req, res) => {
    const roomId = 'bm-test-' + crypto.randomBytes(8).toString('hex');
    req.session.testVideoRoom = roomId;
    req.session.testVideoUrl = `https://meet.jit.si/${roomId}`;
    res.redirect('/admin/owner');
});

// Video test page (opens Jitsi in a full page)
router.get('/owner/video-test', isAuthenticated, isOwner, (req, res) => {
    const room = req.query.room;
    if (!room) return res.redirect('/admin/owner');
    res.render('admin/video-test', {
        title: 'Test Video Call',
        roomId: room,
        userName: req.session.user.firstName + ' ' + req.session.user.lastName,
        meta: {}
    });
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

// Owner profile update
router.get('/owner/profile', isAuthenticated, isOwner, async (req, res) => {
    try {
        const owner = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
        res.render('admin/owner-profile', { title: 'My Profile', owner: owner.rows[0], meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

router.post('/owner/profile', isAuthenticated, isOwner, upload.single('profile_picture'), async (req, res) => {
    try {
        const { first_name, last_name, phone } = req.body;
        const cleanFirst = (first_name || '').trim().substring(0, 100);
        const cleanLast = (last_name || '').trim().substring(0, 100);
        const cleanPhone = (phone || '').trim().substring(0, 20);

        if (req.file) {
            await pool.query('UPDATE users SET first_name = $1, last_name = $2, phone = $3, profile_picture = $4 WHERE id = $5',
                [cleanFirst, cleanLast, cleanPhone, '/uploads/' + req.file.filename, req.session.user.id]);
        } else {
            await pool.query('UPDATE users SET first_name = $1, last_name = $2, phone = $3 WHERE id = $4',
                [cleanFirst, cleanLast, cleanPhone, req.session.user.id]);
        }

        // Update session so nav shows new name
        req.session.user.firstName = cleanFirst;
        req.session.user.lastName = cleanLast;
        if (req.file) req.session.user.profilePicture = '/uploads/' + req.file.filename;

        req.session.success = 'Profile updated!';
        res.redirect('/admin/owner/profile');
    } catch (err) { console.error(err); req.session.error = 'Failed to update.'; res.redirect('/admin/owner/profile'); }
});

// Site settings (edit homepage stats)
router.get('/owner/settings', isAuthenticated, isOwner, async (req, res) => {
    try {
        let settings = {};
        try {
            const result = await pool.query('SELECT "key", "value" FROM site_settings');
            result.rows.forEach(r => { settings[r.key] = r.value; });
        } catch(e) { /* table may not exist */ }
        res.render('admin/settings', { title: 'Site Settings', settings, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

router.post('/owner/settings', isAuthenticated, isOwner, async (req, res) => {
    try {
        const fields = ['stat_satisfaction', 'stat_satisfaction_label', 'stat_students', 'stat_students_label', 'stat_tutors', 'stat_tutors_label', 'stat_improvement', 'stat_improvement_label'];
        for (const key of fields) {
            const val = (req.body[key] || '').trim().substring(0, 200);
            if (val) {
                await pool.query('INSERT INTO site_settings ("key", "value", updated_at) VALUES ($1, $2, NOW()) ON CONFLICT ("key") DO UPDATE SET "value" = $2, updated_at = NOW()', [key, val]);
            }
        }
        req.session.success = 'Homepage stats updated!';
    } catch (err) { console.error(err); req.session.error = 'Failed to save settings.'; }
    res.redirect('/admin/owner/settings');
});

// All tutor availability overview (admin)
router.get('/owner/availability', isAuthenticated, isOwner, async (req, res) => {
    try {
        const tutors = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, tp.subjects
            FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.role = 'tutor' AND u.is_active = true AND tp.approved = true
            ORDER BY u.first_name
        `);

        const availability = await pool.query(`
            SELECT ta.*, u.first_name, u.last_name
            FROM tutor_availability ta JOIN users u ON ta.tutor_id = u.id
            WHERE ta.is_recurring = true
            ORDER BY u.first_name, ta.day_of_week, ta.start_time
        `);

        // Get all unique subjects for filtering
        const subjects = await pool.query(`
            SELECT DISTINCT unnest(tp.subjects) as subject
            FROM tutor_profiles tp JOIN users u ON tp.user_id = u.id
            WHERE u.is_active = true AND tp.approved = true ORDER BY subject
        `);

        res.render('admin/availability-overview', {
            title: 'Tutor Availability',
            tutors: tutors.rows,
            availability: availability.rows,
            subjects: subjects.rows.map(function(r) { return r.subject; }),
            meta: {}
        });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Manage tutors
router.get('/owner/tutors', isAuthenticated, isOwner, async (req, res) => {
    try {
        const tutors = await pool.query(`SELECT u.*, tp.subjects, tp.approved, tp.bio, tp.experience_years, tp.tagline, tp.hourly_rate FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id WHERE u.role = 'tutor' ORDER BY u.first_name`);
        const invites = await pool.query(`SELECT * FROM tutor_invites WHERE used = false AND expires_at > NOW() ORDER BY created_at DESC`);
        res.render('admin/manage-tutors', { title: 'Manage Tutors', tutors: tutors.rows, invites: invites.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Manage students
router.get('/owner/students', isAuthenticated, isOwner, async (req, res) => {
    try {
        const students = await pool.query(`SELECT u.*, sp.grade_level, sp.school_name, sp.subjects_needed FROM users u LEFT JOIN student_profiles sp ON u.id = sp.user_id WHERE u.role IN ('parent', 'student') ORDER BY u.first_name`);
        const tutors = await pool.query(`SELECT u.id, u.first_name, u.last_name FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id WHERE u.role = 'tutor' AND u.is_active = true AND tp.approved = true ORDER BY u.first_name`);

        // Get session counts and subscriptions for each student
        const sessionCounts = await pool.query(`
            SELECT student_id, COUNT(*) as count FROM bookings
            WHERE booking_date >= date_trunc('month', CURRENT_DATE)
            AND booking_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
            AND status IN ('pending','confirmed','completed')
            GROUP BY student_id
        `);
        const subs = await pool.query("SELECT parent_id, plan_name, sessions_per_month, rate_total, status FROM subscriptions WHERE status = 'active'");

        // Build lookup maps
        const countMap = {};
        sessionCounts.rows.forEach(function(r) { countMap[r.student_id] = parseInt(r.count); });
        const subMap = {};
        subs.rows.forEach(function(r) { subMap[r.parent_id] = r; });

        res.render('admin/manage-students', { title: 'Manage Students', students: students.rows, tutors: tutors.rows, sessionCounts: countMap, subscriptions: subMap, meta: {} });
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
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'availability_updated', parsed.length + ' slots saved']); } catch(e) {}
        res.json({ success: true });
    } catch (err) { console.error(err); res.json({ success: false, message: err.message }); }
});

// Session sheet
router.get('/tutor/session-sheet/:bookingId', isAuthenticated, isTutor, async (req, res) => {
    try {
        let booking;
        if (req.session.user.role === 'owner') {
            booking = await pool.query(`SELECT b.*, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users s ON b.student_id = s.id WHERE b.id = $1`, [req.params.bookingId]);
        } else {
            booking = await pool.query(`SELECT b.*, s.first_name as student_first, s.last_name as student_last FROM bookings b JOIN users s ON b.student_id = s.id WHERE b.id = $1 AND b.tutor_id = $2`, [req.params.bookingId, req.session.user.id]);
        }
        if (booking.rows.length === 0) { req.session.error = 'Booking not found.'; return res.redirect(req.session.user.role === 'owner' ? '/admin/owner' : '/admin/tutor'); }
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

// ===== ADMIN-ONLY ROUTES (appended) =====

// Admin: View all session sheets
router.get('/owner/sheets', isAuthenticated, isOwner, async (req, res) => {
    try {
        const filter = req.query.student_id;
        let query = `
            SELECT ss.*, u.first_name as tutor_first, u.last_name as tutor_last,
                   s.first_name as student_first, s.last_name as student_last
            FROM session_sheets ss
            JOIN users u ON ss.tutor_id = u.id
            LEFT JOIN users s ON ss.student_id = s.id
            ORDER BY ss.session_date DESC LIMIT 100
        `;
        let params = [];
        if (filter) {
            query = `
                SELECT ss.*, u.first_name as tutor_first, u.last_name as tutor_last,
                       s.first_name as student_first, s.last_name as student_last
                FROM session_sheets ss
                JOIN users u ON ss.tutor_id = u.id
                LEFT JOIN users s ON ss.student_id = s.id
                WHERE ss.student_id = $1
                ORDER BY ss.session_date DESC LIMIT 100
            `;
            params = [parseInt(filter)];
        }
        const sheets = await pool.query(query, params);
        const students = await pool.query("SELECT id, first_name, last_name FROM users WHERE role IN ('parent','student') AND is_active = true ORDER BY first_name");
        res.render('admin/all-sheets', { title: 'All Session Sheets', sheets: sheets.rows, students: students.rows, currentFilter: filter || '', meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Admin: View all messages between tutors and students
router.get('/owner/messages', isAuthenticated, isOwner, async (req, res) => {
    try {
        const search = req.query.search || '';
        const personId = req.query.person || '';

        // Get all unique people who have messaged
        const people = await pool.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.role
            FROM users u WHERE u.id IN (SELECT sender_id FROM messages UNION SELECT receiver_id FROM messages)
            ORDER BY u.first_name
        `);

        let messages = [];
        if (personId) {
            const q = `SELECT m.*, s.first_name as sender_first, s.last_name as sender_last, s.role as sender_role,
                   r.first_name as receiver_first, r.last_name as receiver_last, r.role as receiver_role
                   FROM messages m JOIN users s ON m.sender_id = s.id JOIN users r ON m.receiver_id = r.id
                   WHERE (m.sender_id = $1 OR m.receiver_id = $1) ORDER BY m.created_at DESC LIMIT 200`;
            const result = await pool.query(q, [parseInt(personId)]);
            messages = result.rows;
        } else if (search) {
            const result = await pool.query(`
                SELECT m.*, s.first_name as sender_first, s.last_name as sender_last, s.role as sender_role,
                       r.first_name as receiver_first, r.last_name as receiver_last, r.role as receiver_role
                FROM messages m JOIN users s ON m.sender_id = s.id JOIN users r ON m.receiver_id = r.id
                WHERE m.body ILIKE $1 ORDER BY m.created_at DESC LIMIT 200
            `, ['%' + search.substring(0, 100) + '%']);
            messages = result.rows;
        } else {
            const result = await pool.query(`
                SELECT m.*, s.first_name as sender_first, s.last_name as sender_last, s.role as sender_role,
                       r.first_name as receiver_first, r.last_name as receiver_last, r.role as receiver_role
                FROM messages m JOIN users s ON m.sender_id = s.id JOIN users r ON m.receiver_id = r.id
                ORDER BY m.created_at DESC LIMIT 200
            `);
            messages = result.rows;
        }

        res.render('admin/all-messages', { title: 'All Messages', messages, people: people.rows, currentPerson: personId, currentSearch: search, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Admin: Audit log
router.get('/owner/audit-log', isAuthenticated, isOwner, async (req, res) => {
    try {
        const logs = await pool.query(`
            SELECT al.*, u.first_name, u.last_name
            FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
            ORDER BY al.created_at DESC LIMIT 200
        `);
        res.render('admin/audit-log', { title: 'Audit Log', logs: logs.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/admin/owner'); }
});

// Mark attendance on a booking
router.post('/owner/bookings/:id/attendance', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { attendance } = req.body;
        const validStatuses = ['present', 'absent', 'makeup_pending', 'makeup_done'];
        if (!validStatuses.includes(attendance)) { req.session.error = 'Invalid status.'; return res.redirect(req.headers.referer || '/admin/owner'); }
        const makeupDeadline = attendance === 'absent' ? new Date(Date.now() + 30*24*60*60*1000).toISOString().substring(0,10) : null;
        await pool.query('UPDATE bookings SET attendance = $1, makeup_deadline = $2 WHERE id = $3', [attendance, makeupDeadline, req.params.id]);
        // Log it
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'attendance_marked', 'Booking ' + req.params.id + ' marked ' + attendance]); } catch(e) {}
        req.session.success = 'Attendance updated.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect(req.headers.referer || '/admin/owner');
});

// Tutor can also mark attendance
router.post('/tutor/bookings/:id/attendance', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { attendance } = req.body;
        if (!['present', 'absent'].includes(attendance)) { req.session.error = 'Invalid.'; return res.redirect('/admin/tutor'); }
        const makeupDeadline = attendance === 'absent' ? new Date(Date.now() + 30*24*60*60*1000).toISOString().substring(0,10) : null;
        await pool.query('UPDATE bookings SET attendance = $1, makeup_deadline = $2 WHERE id = $3 AND tutor_id = $4', [attendance, makeupDeadline, req.params.id, req.session.user.id]);
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'attendance_marked', 'Booking ' + req.params.id + ' marked ' + attendance]); } catch(e) {}
        req.session.success = 'Attendance marked.';
    } catch (err) { console.error(err); }
    res.redirect('/admin/tutor');
});

// Set student payment status
router.post('/owner/users/:id/payment', isAuthenticated, isOwner, async (req, res) => {
    try {
        const status = req.body.payment_status === 'paid' ? 'paid' : 'unpaid';
        await pool.query('UPDATE users SET payment_status = $1 WHERE id = $2', [status, req.params.id]);
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'payment_status_changed', 'User ' + req.params.id + ' set to ' + status]); } catch(e) {}
        req.session.success = 'Payment status updated.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect(req.headers.referer || '/admin/owner/students');
});

// Set tutor hourly rate
router.post('/owner/tutors/:id/rate', isAuthenticated, isOwner, async (req, res) => {
    try {
        const rate = parseFloat(req.body.hourly_rate) || 0;
        await pool.query('UPDATE tutor_profiles SET hourly_rate = $1 WHERE user_id = $2', [rate, req.params.id]);
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'tutor_rate_set', 'Tutor ' + req.params.id + ' rate set to $' + rate]); } catch(e) {}
        req.session.success = 'Rate updated.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect(req.headers.referer || '/admin/owner/tutors');
});

// Set student subscription plan (sessions per month + total rate)
router.post('/owner/users/:id/plan', isAuthenticated, isOwner, async (req, res) => {
    try {
        const sessions = parseInt(req.body.sessions_per_month) || 4;
        const rate = parseFloat(req.body.rate_total) || 0;
        const extraRate = req.body.extra_session_rate ? parseFloat(req.body.extra_session_rate) : null;
        const planName = req.body.plan_name || 'Starter';

        // Upsert subscription
        const existing = await pool.query("SELECT id FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [req.params.id]);
        if (existing.rows.length > 0) {
            await pool.query('UPDATE subscriptions SET sessions_per_month = $1, rate_total = $2, plan_name = $3, extra_session_rate = $4 WHERE id = $5', [sessions, rate, planName, extraRate, existing.rows[0].id]);
        } else {
            await pool.query("INSERT INTO subscriptions (parent_id, plan_name, price, sessions_per_month, rate_total, extra_session_rate, start_date, next_billing_date, status) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 month', 'active')", [req.params.id, planName, rate, sessions, rate, extraRate]);
        }
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'plan_updated', 'User ' + req.params.id + ': ' + planName + ' (' + sessions + ' sessions, $' + rate + '/mo, extra: $' + (extraRate || 'auto') + ')']); } catch(e) {}
        req.session.success = 'Plan updated.';
    } catch (err) { console.error(err); req.session.error = 'Failed.'; }
    res.redirect(req.headers.referer || '/admin/owner/students');
});

// Create recurring meeting
router.post('/owner/recurring', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { tutor_id, student_id, day_of_week, start_time, end_time, subject, weeks } = req.body;
        const crypto = require('crypto');
        const numWeeks = Math.min(Math.max(parseInt(weeks) || 8, 1), 52);

        // Generate N weeks of bookings
        const today = new Date();
        let generated = 0;
        for (let w = 0; w < numWeeks; w++) {
            const date = new Date(today);
            date.setDate(today.getDate() + ((parseInt(day_of_week) - today.getDay() + 7) % 7) + (w * 7));
            if (date <= today && w === 0) date.setDate(date.getDate() + 7);
            const dateStr = date.toISOString().substring(0, 10);
            const roomId = 'bm-' + crypto.randomBytes(16).toString('hex');

            // Check no conflict
            const conflict = await pool.query("SELECT id FROM bookings WHERE tutor_id = $1 AND booking_date = $2 AND start_time = $3 AND status IN ('pending','confirmed')", [tutor_id, dateStr, start_time]);
            if (conflict.rows.length === 0) {
                await pool.query("INSERT INTO bookings (tutor_id, student_id, parent_id, booking_date, start_time, end_time, subject, meeting_room_id, status, is_recurring_booking, recurring_day) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'confirmed',true,$8)",
                    [tutor_id, student_id, dateStr, start_time, end_time, subject || 'General', roomId, parseInt(day_of_week)]);
                generated++;
            }
        }
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'recurring_created', 'Tutor ' + tutor_id + ' + Student ' + student_id + ': ' + generated + ' sessions on day ' + day_of_week]); } catch(e) {}
        req.session.success = generated + ' recurring sessions created!';
    } catch (err) { console.error(err); req.session.error = 'Failed: ' + err.message; }
    res.redirect(req.headers.referer || '/admin/owner/students');
});

// Tutor reschedule a booking
router.post('/tutor/bookings/:id/reschedule', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { new_date, new_start, new_end } = req.body;
        if (!new_date || !new_start || !new_end) { req.session.error = 'Please fill all fields.'; return res.redirect('/admin/tutor'); }
        // Verify tutor owns this booking
        const booking = await pool.query('SELECT * FROM bookings WHERE id = $1 AND tutor_id = $2', [req.params.id, req.session.user.id]);
        if (booking.rows.length === 0) { req.session.error = 'Booking not found.'; return res.redirect('/admin/tutor'); }
        const old = booking.rows[0];
        await pool.query('UPDATE bookings SET booking_date = $1, start_time = $2, end_time = $3, status = $4 WHERE id = $5',
            [new_date, new_start, new_end, 'confirmed', req.params.id]);
        try {
            await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)',
                [req.session.user.id, 'booking_rescheduled', 'Booking #' + req.params.id + ' moved from ' + old.booking_date.toISOString().substring(0,10) + ' to ' + new_date]);
        } catch(e) {}
        req.session.success = 'Session rescheduled!';
    } catch (err) { console.error(err); req.session.error = 'Failed to reschedule.'; }
    res.redirect('/admin/tutor');
});

// Admin: Create group session (same Jitsi room for multiple students)
router.post('/owner/group-session', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { tutor_id, student_ids, booking_date, start_time, end_time, subject } = req.body;
        const cryptoMod = require('crypto');
        const roomId = 'bm-group-' + cryptoMod.randomBytes(16).toString('hex');
        const students = Array.isArray(student_ids) ? student_ids : [student_ids];

        let created = 0;
        for (const sid of students) {
            if (!sid) continue;
            await pool.query(
                "INSERT INTO bookings (tutor_id, student_id, parent_id, booking_date, start_time, end_time, subject, meeting_room_id, status) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'confirmed')",
                [tutor_id, sid, booking_date, start_time, end_time, subject || 'Group Session', roomId]
            );
            created++;
        }
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'group_session_created', created + ' students, room ' + roomId.substring(0, 20)]); } catch(e) {}
        req.session.success = 'Group session created for ' + created + ' students! They all share the same video room.';
    } catch (err) { console.error(err); req.session.error = 'Failed: ' + err.message; }
    res.redirect(req.headers.referer || '/admin/owner/students');
});

module.exports = router;
