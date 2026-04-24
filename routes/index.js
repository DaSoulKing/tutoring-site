const router = require('express').Router();
const pool = require('../db/pool');
const { verifyRecaptcha } = require('../middleware/recaptcha');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext) && ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype));
}});

// Home page
router.get('/', async (req, res) => {
    try {
        // Pull ALL approved tutors for carousel (not just featured)
        const tutorsResult = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.profile_picture,
                   tp.bio, tp.tagline, tp.subjects, tp.carousel_description
            FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.is_active = true AND tp.approved = true
            ORDER BY tp.is_featured DESC, RANDOM() LIMIT 20
        `);

        // Pull editable stats
        let stats = { stat_satisfaction: '97%', stat_satisfaction_label: 'Student Satisfaction', stat_students: '500+', stat_students_label: 'Students Helped', stat_tutors: '50+', stat_tutors_label: 'Expert Tutors', stat_improvement: '92%', stat_improvement_label: 'Grade Improvement' };
        try {
            const settingsResult = await pool.query('SELECT "key", "value" FROM site_settings WHERE "key" LIKE \'stat_%\'');
            settingsResult.rows.forEach(r => { stats[r.key] = r.value; });
        } catch(e) { /* table might not exist yet */ }

        res.render('home', {
            title: (process.env.SITE_NAME || 'BrainBridge') + ' - Where Learning Comes Alive',
            tutors: tutorsResult.rows, stats,
            meta: { description: (process.env.SITE_NAME || 'BrainBridge') + ' offers personalized, engaging tutoring for students of all ages. Part of every payment goes to charity.', keywords: 'tutoring, education, kids tutoring, online tutoring' }
        });
    } catch (err) {
        console.error(err);
        res.render('home', { title: process.env.SITE_NAME || 'BrainBridge', tutors: [], stats: {}, meta: {} });
    }
});

// About
router.get('/about', async (req, res) => {
    try {
        const owners = await pool.query(`SELECT u.first_name, u.last_name, u.profile_picture FROM users u WHERE u.role = 'owner' AND u.is_active = true`);
        const tutors = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.profile_picture, tp.bio, tp.tagline, tp.subjects, tp.experience_years
            FROM users u JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.is_active = true AND tp.approved = true ORDER BY tp.is_featured DESC, u.first_name
        `);
        res.render('about', { title: 'About Us - BrainBridge', owners: owners.rows, tutors: tutors.rows, meta: { description: 'Meet the passionate team behind BrainBridge.' } });
    } catch (err) {
        console.error(err);
        res.render('about', { title: 'About Us', owners: [], tutors: [], meta: {} });
    }
});

// Contact
router.get('/contact', (req, res) => {
    res.render('contact', { title: 'Contact Us - BrainBridge', meta: { description: 'Get in touch with BrainBridge.' } });
});
router.post('/contact', verifyRecaptcha, async (req, res) => {
    try {
        const { name, email, phone, inquiry_type, subject, message } = req.body;
        await pool.query(`INSERT INTO inquiries (user_id, name, email, phone, inquiry_type, subject, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [req.session.user?.id || null, name, email, phone || null, inquiry_type || 'general', subject, message]);
        req.session.success = 'Your message has been sent! We will get back to you soon.';
        res.redirect('/contact');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/contact'); }
});

// Services
router.get('/services', (req, res) => {
    res.render('services', { title: 'Our Services - BrainBridge', meta: { description: 'Explore our tutoring services.' } });
});

// Consultation
router.get('/consultation', (req, res) => {
    res.render('consultation', { title: 'Book a Free Consultation - BrainBridge', meta: { description: 'Book a free consultation call.' } });
});
router.post('/consultation', verifyRecaptcha, async (req, res) => {
    try {
        const { name, email, phone, child_grade, subjects, preferred_time, message } = req.body;
        await pool.query(`INSERT INTO inquiries (name, email, phone, inquiry_type, subject, message) VALUES ($1,$2,$3,'inquiry',$4,$5)`,
            [name, email, phone, 'Free Consultation Request', `Grade: ${child_grade}\nSubjects: ${subjects}\nPreferred Time: ${preferred_time}\nMessage: ${message || 'N/A'}`]);
        req.session.success = 'Your consultation request has been submitted! We will contact you within 24 hours.';
        res.redirect('/consultation');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/consultation'); }
});

// Employment
router.get('/employment', (req, res) => {
    res.render('employment', { title: 'Join Our Team - BrainBridge', meta: { description: 'Apply to become a tutor.' } });
});
router.post('/employment', upload.single('resume'), verifyRecaptcha, async (req, res) => {
    try {
        const { applicant_type, first_name, last_name, email, phone, subjects, experience, education, availability, why_join, cover_letter } = req.body;
        const resumePath = req.file ? '/uploads/' + req.file.filename : null;
        const subjectsArray = subjects ? subjects.split(',').map(s => s.trim()) : [];
        await pool.query(`INSERT INTO applications (applicant_type, first_name, last_name, email, phone, resume_path, cover_letter, subjects, experience, education, availability, why_join) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [applicant_type, first_name, last_name, email, phone, resumePath, cover_letter, subjectsArray, experience, education, availability, why_join]);
        req.session.success = 'Your application has been submitted!';
        res.redirect('/employment');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/employment'); }
});

// Terms
router.get('/terms', (req, res) => {
    res.render('terms', { title: 'Terms & Conditions - BrainBridge', meta: { description: 'Read our terms of service.' } });
});

// Charity
router.get('/charity', (req, res) => {
    res.render('charity', { title: 'Our Charity Mission - BrainBridge', meta: { description: '3% of every payment goes to the Kids Education Fund.' } });
});

// Checkout/Pricing - info page, book consultation to start
router.get('/checkout', (req, res) => {
    res.render('checkout', { title: 'Pricing - BrainBridge', meta: { description: 'Our tutoring plans and pricing.' } });
});

// Referral code check (one-time use, owner-assigned)
router.post('/checkout/apply-referral', async (req, res) => {
    try {
        const { referral_code } = req.body;
        const result = await pool.query(
            `SELECT * FROM referral_codes WHERE code = $1 AND is_active = true AND used_by IS NULL`,
            [referral_code.toUpperCase()]
        );
        if (result.rows.length > 0) {
            return res.json({ success: true, discount: result.rows[0].discount_percent, message: `Referral code applied! ${result.rows[0].discount_percent}% discount.` });
        }
        const used = await pool.query('SELECT id FROM referral_codes WHERE code = $1 AND used_by IS NOT NULL', [referral_code.toUpperCase()]);
        if (used.rows.length > 0) {
            return res.json({ success: false, message: 'This referral code has already been used.' });
        }
        res.json({ success: false, message: 'Invalid referral code.' });
    } catch (err) { console.error(err); res.json({ success: false, message: 'Something went wrong.' }); }
});

// Secret tutor signup
const rateLimit = require('express-rate-limit');
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many signup attempts.' });

router.get('/tutor-signup/:token', async (req, res) => {
    try {
        const invite = await pool.query(`SELECT * FROM tutor_invites WHERE token = $1 AND used = false AND expires_at > NOW()`, [req.params.token]);
        if (invite.rows.length === 0) {
            return res.render('error', { title: 'Invalid Link', message: 'This signup link is invalid or has expired. Please contact the admin for a new one.', code: 403 });
        }
        res.render('auth/tutor-signup', { title: 'Tutor Sign Up - BrainBridge', invite: invite.rows[0], token: req.params.token, meta: {} });
    } catch (err) { console.error(err); res.render('error', { title: 'Error', message: 'Something went wrong.', code: 500 }); }
});

router.post('/tutor-signup/:token', signupLimiter, async (req, res) => {
    try {
        const invite = await pool.query(`SELECT * FROM tutor_invites WHERE token = $1 AND used = false AND expires_at > NOW()`, [req.params.token]);
        if (invite.rows.length === 0) { req.session.error = 'This signup link is invalid or has expired.'; return res.redirect('/'); }

        const { email, password, confirm_password, first_name, last_name, phone, subjects, grade_levels, bio } = req.body;
        if (password !== confirm_password) { req.session.error = 'Passwords do not match.'; return res.redirect(`/tutor-signup/${req.params.token}`); }
        if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
            req.session.error = 'Password must be 8+ characters with uppercase, lowercase, and a number.';
            return res.redirect(`/tutor-signup/${req.params.token}`);
        }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) { req.session.error = 'An account with this email already exists.'; return res.redirect(`/tutor-signup/${req.params.token}`); }

        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(password, 12);
        const refCode = 'BM' + crypto.randomBytes(4).toString('hex').toUpperCase();

        // Parse subjects from tutor's selection
        let subjectsArray = [];
        if (subjects) {
            subjectsArray = typeof subjects === 'string' ? subjects.split(',').map(s => s.trim()).filter(Boolean) : subjects;
        }

        const newUser = await pool.query(`
            INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code, email_verified)
            VALUES ($1, $2, 'tutor', $3, $4, $5, $6, true) RETURNING id, email, role, first_name, last_name, referral_code
        `, [email.toLowerCase(), hash, first_name, last_name, phone || null, refCode]);

        const user = newUser.rows[0];
        await pool.query(`INSERT INTO tutor_profiles (user_id, approved, subjects, bio, grade_levels) VALUES ($1, true, $2, $3, $4)`, [user.id, subjectsArray, (bio || '').trim().substring(0, 2000), (grade_levels || '').trim().substring(0, 500)]);
        await pool.query('UPDATE tutor_invites SET used = true, used_by = $1, used_at = NOW() WHERE token = $2', [user.id, req.params.token]);

        req.session.user = { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name, referralCode: user.referral_code };
        req.session.success = 'Welcome to BrainBridge! Your tutor account is ready.';
        res.redirect('/admin/tutor');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect(`/tutor-signup/${req.params.token}`); }
});

module.exports = router;
