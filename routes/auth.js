const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const crypto = require('crypto');
const { verifyRecaptcha } = require('../middleware/recaptcha');

// Login
router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('auth/login', { title: 'Log In - BrightMinds Tutoring', meta: {} });
});

router.post('/login', verifyRecaptcha, async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);
        if (result.rows.length === 0) { req.session.error = 'Invalid email or password.'; return res.redirect('/auth/login'); }

        const user = result.rows[0];

        // Check if email is verified (skip for owners)
        if (user.role !== 'owner' && !user.email_verified) {
            req.session.error = 'Please verify your email first. Check your inbox for a verification link.';
            return res.redirect('/auth/login');
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) { req.session.error = 'Invalid email or password.'; return res.redirect('/auth/login'); }

        req.session.user = {
            id: user.id, email: user.email, role: user.role,
            firstName: user.first_name, lastName: user.last_name,
            profilePicture: user.profile_picture, referralCode: user.referral_code,
        };

        const returnTo = req.session.returnTo || getDashboardUrl(user.role);
        delete req.session.returnTo;
        res.redirect(returnTo);
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/login'); }
});

// Register
router.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('auth/register', { title: 'Sign Up - BrightMinds Tutoring', meta: {} });
});

router.post('/register', verifyRecaptcha, async (req, res) => {
    try {
        const { email, password, confirm_password, first_name, last_name, phone, role } = req.body;

        if (password !== confirm_password) { req.session.error = 'Passwords do not match.'; return res.redirect('/auth/register'); }
        if (password.length < 8) { req.session.error = 'Password must be at least 8 characters.'; return res.redirect('/auth/register'); }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) { req.session.error = 'An account with this email already exists.'; return res.redirect('/auth/register'); }

        const hash = await bcrypt.hash(password, 12);
        const userReferralCode = 'BM' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const allowedRole = ['parent', 'student'].includes(role) ? role : 'parent';

        const result = await pool.query(`
            INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code, email_verified, verify_token)
            VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
            RETURNING id, email, role, first_name, last_name, referral_code
        `, [email.toLowerCase(), hash, allowedRole, first_name, last_name, phone || null, userReferralCode, verifyToken]);

        const user = result.rows[0];

        // Schedule first check-in
        await pool.query(`INSERT INTO checkins (student_id, due_date) VALUES ($1, CURRENT_DATE + INTERVAL '3 months')`, [user.id]);

        // Send verification email (log for now)
        const verifyUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/auth/verify/${verifyToken}`;
        console.log(`VERIFICATION EMAIL for ${email}: ${verifyUrl}`);

        // Try sending actual email
        try {
            const nodemailer = require('nodemailer');
            if (process.env.SMTP_HOST) {
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                });
                await transporter.sendMail({
                    from: process.env.EMAIL_FROM, to: email,
                    subject: 'Verify your BrightMinds account',
                    html: `<h2>Welcome to BrightMinds!</h2><p>Click the link below to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`
                });
            }
        } catch (emailErr) { console.error('Email send failed:', emailErr); }

        req.session.success = 'Account created! Please check your email to verify your account before logging in.';
        res.redirect('/auth/login');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/register'); }
});

// Email verification
router.get('/verify/:token', async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE users SET email_verified = true, verify_token = NULL WHERE verify_token = $1 AND email_verified = false RETURNING email',
            [req.params.token]
        );
        if (result.rows.length > 0) {
            req.session.success = 'Email verified! You can now log in.';
        } else {
            req.session.error = 'Invalid or expired verification link.';
        }
        res.redirect('/auth/login');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/login'); }
});

// Forgot password
router.get('/forgot-password', (req, res) => {
    res.render('auth/forgot-password', { title: 'Reset Password - BrightMinds', meta: {} });
});

router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const user = await pool.query('SELECT id, email FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);

        if (user.rows.length > 0) {
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

            await pool.query('UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3', [token, expires, user.rows[0].id]);

            const resetUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/auth/reset-password/${token}`;
            console.log(`RESET PASSWORD for ${email}: ${resetUrl}`);

            try {
                const nodemailer = require('nodemailer');
                if (process.env.SMTP_HOST) {
                    const transporter = nodemailer.createTransport({
                        host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
                        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                    });
                    await transporter.sendMail({
                        from: process.env.EMAIL_FROM, to: email,
                        subject: 'Reset your BrightMinds password',
                        html: `<h2>Password Reset</h2><p>Click the link below to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`
                    });
                }
            } catch (emailErr) { console.error('Email send failed:', emailErr); }
        }

        // Always show success to prevent email enumeration
        req.session.success = 'If an account with that email exists, a password reset link has been sent.';
        res.redirect('/auth/forgot-password');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/forgot-password'); }
});

// Reset password form
router.get('/reset-password/:token', async (req, res) => {
    try {
        const user = await pool.query('SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()', [req.params.token]);
        if (user.rows.length === 0) {
            req.session.error = 'Invalid or expired reset link.';
            return res.redirect('/auth/forgot-password');
        }
        res.render('auth/reset-password', { title: 'Set New Password - BrightMinds', token: req.params.token, meta: {} });
    } catch (err) { console.error(err); res.redirect('/auth/forgot-password'); }
});

router.post('/reset-password/:token', async (req, res) => {
    try {
        const { password, confirm_password } = req.body;
        if (password !== confirm_password) { req.session.error = 'Passwords do not match.'; return res.redirect(`/auth/reset-password/${req.params.token}`); }
        if (password.length < 8) { req.session.error = 'Password must be at least 8 characters.'; return res.redirect(`/auth/reset-password/${req.params.token}`); }

        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            'UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE reset_token = $2 AND reset_expires > NOW() RETURNING email',
            [hash, req.params.token]
        );

        if (result.rows.length > 0) {
            req.session.success = 'Password reset! You can now log in with your new password.';
        } else {
            req.session.error = 'Invalid or expired reset link.';
        }
        res.redirect('/auth/login');
    } catch (err) { console.error(err); req.session.error = 'Something went wrong.'; res.redirect('/auth/login'); }
});

// Logout
router.get('/logout', (req, res) => { req.session.destroy(() => { res.redirect('/'); }); });

function getDashboardUrl(role) {
    switch (role) {
        case 'owner': return '/admin/owner';
        case 'tutor': return '/admin/tutor';
        default: return '/parent/dashboard';
    }
}

module.exports = router;
