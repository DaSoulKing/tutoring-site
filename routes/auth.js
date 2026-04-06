const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const crypto = require('crypto');
const { verifyRecaptcha } = require('../middleware/recaptcha');
const rateLimit = require('express-rate-limit');

// Strict rate limits on auth routes to prevent brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 10, // 10 attempts per window
    message: 'Too many attempts. Please try again in 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 registrations per hour per IP
    message: 'Too many accounts created. Please try again later.',
});

// Helper: check if SMTP is configured
function smtpConfigured() {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Helper: send email (returns true/false)
async function sendEmail(to, subject, html) {
    if (!smtpConfigured()) return false;
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
    } catch (err) {
        console.error('Email send failed:', err.message);
        return false;
    }
}

// Helper: sanitize string input
function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, 500);
}

// Login
router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('auth/login', { title: 'Log In', meta: {} });
});

router.post('/login', authLimiter, verifyRecaptcha, async (req, res) => {
    try {
        const email = sanitize(req.body.email).toLowerCase();
        const password = req.body.password || '';

        if (!email || !password) {
            req.session.error = 'Email and password are required.';
            return res.redirect('/auth/login');
        }

        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
        if (result.rows.length === 0) {
            // Constant-time fake compare to prevent timing attacks
            await bcrypt.compare(password, '$2a$12$000000000000000000000000000000000000000000000000000000');
            req.session.error = 'Invalid email or password.';
            return res.redirect('/auth/login');
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            req.session.error = 'Invalid email or password.';
            return res.redirect('/auth/login');
        }

        // Check email verification (skip for owners and tutors signed up via invite)
        if (user.role !== 'owner' && user.role !== 'tutor' && user.email_verified === false) {
            req.session.error = 'Please verify your email first. Check your inbox or <a href="/auth/resend-verification?email=' + encodeURIComponent(email) + '">click here to resend</a>.';
            return res.redirect('/auth/login');
        }

        // Regenerate session to prevent fixation
        const returnTo = req.session.returnTo;
        req.session.regenerate((err) => {
            if (err) { console.error(err); req.session.error = 'Something went wrong.'; return res.redirect('/auth/login'); }
            req.session.user = {
                id: user.id, email: user.email, role: user.role,
                firstName: user.first_name, lastName: user.last_name,
                profilePicture: user.profile_picture, referralCode: user.referral_code,
            };
            res.redirect(returnTo || getDashboardUrl(user.role));
        });
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong.';
        res.redirect('/auth/login');
    }
});

// Register
router.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('auth/register', { title: 'Sign Up', meta: {} });
});

router.post('/register', registerLimiter, verifyRecaptcha, async (req, res) => {
    try {
        const email = sanitize(req.body.email).toLowerCase();
        const password = req.body.password || '';
        const confirm_password = req.body.confirm_password || '';
        const first_name = sanitize(req.body.first_name);
        const last_name = sanitize(req.body.last_name);
        const phone = sanitize(req.body.phone);
        const role = req.body.role;

        // Validation
        if (!email || !password || !first_name || !last_name) {
            req.session.error = 'All required fields must be filled.';
            return res.redirect('/auth/register');
        }
        if (password !== confirm_password) { req.session.error = 'Passwords do not match.'; return res.redirect('/auth/register'); }
        if (password.length < 8) { req.session.error = 'Password must be at least 8 characters.'; return res.redirect('/auth/register'); }
        // Basic email format check
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { req.session.error = 'Please enter a valid email.'; return res.redirect('/auth/register'); }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) { req.session.error = 'An account with this email already exists.'; return res.redirect('/auth/register'); }

        const hash = await bcrypt.hash(password, 12);
        const userReferralCode = 'BM' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const allowedRole = ['parent', 'student'].includes(role) ? role : 'parent';

        // If SMTP is not configured, auto-verify so users can actually log in
        const autoVerify = !smtpConfigured();

        const result = await pool.query(`
            INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code, email_verified, verify_token)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, email, role, first_name, last_name, referral_code
        `, [email, hash, allowedRole, first_name, last_name, phone || null, userReferralCode, autoVerify, autoVerify ? null : verifyToken]);

        const user = result.rows[0];

        // Schedule first check-in
        await pool.query(`INSERT INTO checkins (student_id, due_date) VALUES ($1, CURRENT_DATE + INTERVAL '3 months')`, [user.id]);

        if (!autoVerify) {
            // Send verification email
            const verifyUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/auth/verify/${verifyToken}`;
            const sent = await sendEmail(email,
                'Verify your BrightMinds account',
                `<h2>Welcome to BrightMinds!</h2><p>Click the link below to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`
            );
            if (!sent) {
                // Email failed to send, auto-verify so they're not locked out
                await pool.query('UPDATE users SET email_verified = true, verify_token = NULL WHERE id = $1', [user.id]);
                console.log(`Auto-verified ${email} because email send failed`);
            }
        }

        if (autoVerify) {
            // Log them in directly since we auto-verified
            req.session.user = {
                id: user.id, email: user.email, role: user.role,
                firstName: user.first_name, lastName: user.last_name, referralCode: user.referral_code,
            };
            req.session.success = 'Welcome to BrightMinds!';
            return res.redirect(getDashboardUrl(user.role));
        }

        req.session.success = 'Account created! Check your email to verify before logging in.';
        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong.';
        res.redirect('/auth/register');
    }
});

// Resend verification
router.get('/resend-verification', async (req, res) => {
    try {
        const email = sanitize(req.query.email).toLowerCase();
        if (!email) { req.session.error = 'Email is required.'; return res.redirect('/auth/login'); }

        const user = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [email]);
        if (user.rows.length > 0 && !user.rows[0].email_verified) {
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query('UPDATE users SET verify_token = $1 WHERE id = $2', [token, user.rows[0].id]);

            const verifyUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/auth/verify/${token}`;
            const sent = await sendEmail(email,
                'Verify your BrightMinds account',
                `<h2>Email Verification</h2><p>Click to verify: <a href="${verifyUrl}">${verifyUrl}</a></p>`
            );
            if (!sent) {
                // Can't send email, just verify them
                await pool.query('UPDATE users SET email_verified = true, verify_token = NULL WHERE id = $1', [user.rows[0].id]);
                req.session.success = 'Your account has been verified. You can now log in.';
                return res.redirect('/auth/login');
            }
        }
        req.session.success = 'If that email exists, a verification link has been sent.';
        res.redirect('/auth/login');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/login'); }
});

// Email verification
router.get('/verify/:token', async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE users SET email_verified = true, verify_token = NULL WHERE verify_token = $1 AND email_verified = false RETURNING email',
            [req.params.token]
        );
        req.session[result.rows.length > 0 ? 'success' : 'error'] = result.rows.length > 0 ? 'Email verified! You can now log in.' : 'Invalid or expired verification link.';
        res.redirect('/auth/login');
    } catch (err) { console.error(err); res.redirect('/auth/login'); }
});

// Forgot password
router.get('/forgot-password', (req, res) => {
    res.render('auth/forgot-password', { title: 'Reset Password', meta: {} });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
    try {
        const email = sanitize(req.body.email).toLowerCase();
        const user = await pool.query('SELECT id FROM users WHERE email = $1 AND is_active = true', [email]);

        if (user.rows.length > 0) {
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 60 * 60 * 1000);
            await pool.query('UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3', [token, expires, user.rows[0].id]);

            const resetUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/auth/reset-password/${token}`;
            await sendEmail(email,
                'Reset your BrightMinds password',
                `<h2>Password Reset</h2><p>Click to reset: <a href="${resetUrl}">${resetUrl}</a></p><p>Expires in 1 hour.</p>`
            );
        }
        // Always show success to prevent email enumeration
        req.session.success = 'If an account with that email exists, a reset link has been sent.';
        res.redirect('/auth/forgot-password');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/forgot-password'); }
});

// Reset password
router.get('/reset-password/:token', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()', [req.params.token]);
        if (user.rows.length === 0) { req.session.error = 'Invalid or expired reset link.'; return res.redirect('/auth/forgot-password'); }
        res.render('auth/reset-password', { title: 'Set New Password', token: req.params.token, meta: {} });
    } catch (err) { res.redirect('/auth/forgot-password'); }
});

router.post('/reset-password/:token', authLimiter, async (req, res) => {
    try {
        const password = req.body.password || '';
        const confirm_password = req.body.confirm_password || '';
        if (password !== confirm_password) { req.session.error = 'Passwords do not match.'; return res.redirect(`/auth/reset-password/${req.params.token}`); }
        if (password.length < 8) { req.session.error = 'Password must be at least 8 characters.'; return res.redirect(`/auth/reset-password/${req.params.token}`); }

        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            'UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE reset_token = $2 AND reset_expires > NOW() RETURNING email',
            [hash, req.params.token]
        );
        req.session[result.rows.length > 0 ? 'success' : 'error'] = result.rows.length > 0 ? 'Password reset! You can now log in.' : 'Invalid or expired reset link.';
        res.redirect('/auth/login');
    } catch (err) { console.error(err); res.redirect('/auth/login'); }
});

// Logout - POST preferred for security, GET as fallback
router.get('/logout', (req, res) => {
    req.session.destroy(() => { res.redirect('/'); });
});

function getDashboardUrl(role) {
    switch (role) {
        case 'owner': return '/admin/owner';
        case 'tutor': return '/admin/tutor';
        default: return '/parent/dashboard';
    }
}

module.exports = router;
