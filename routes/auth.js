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

        if (result.rows.length === 0) {
            req.session.error = 'Invalid email or password.';
            return res.redirect('/auth/login');
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            req.session.error = 'Invalid email or password.';
            return res.redirect('/auth/login');
        }

        req.session.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.first_name,
            lastName: user.last_name,
            profilePicture: user.profile_picture,
            referralCode: user.referral_code,
        };

        const returnTo = req.session.returnTo || getDashboardUrl(user.role);
        delete req.session.returnTo;
        res.redirect(returnTo);
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong. Please try again.';
        res.redirect('/auth/login');
    }
});

// Register
router.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('auth/register', { title: 'Sign Up - BrightMinds Tutoring', meta: {} });
});

router.post('/register', verifyRecaptcha, async (req, res) => {
    try {
        const { email, password, confirm_password, first_name, last_name, phone, role, referral_code } = req.body;

        if (password !== confirm_password) {
            req.session.error = 'Passwords do not match.';
            return res.redirect('/auth/register');
        }

        if (password.length < 8) {
            req.session.error = 'Password must be at least 8 characters.';
            return res.redirect('/auth/register');
        }

        // Check if email exists
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) {
            req.session.error = 'An account with this email already exists.';
            return res.redirect('/auth/register');
        }

        const hash = await bcrypt.hash(password, 12);
        const userReferralCode = 'BM' + crypto.randomBytes(4).toString('hex').toUpperCase();

        // Check referral code
        let referrerId = null;
        if (referral_code) {
            const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()]);
            if (referrer.rows.length > 0) {
                referrerId = referrer.rows[0].id;
            }
        }

        // Only allow parent/student registration (tutors apply through employment page)
        const allowedRole = ['parent', 'student'].includes(role) ? role : 'parent';

        const result = await pool.query(`
            INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code, referred_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, email, role, first_name, last_name, referral_code
        `, [email.toLowerCase(), hash, allowedRole, first_name, last_name, phone || null, userReferralCode, referrerId]);

        const user = result.rows[0];

        // Track referral usage
        if (referrerId) {
            await pool.query(`
                INSERT INTO referral_usage (referral_code, referrer_id, referred_id, discount_percent)
                VALUES ($1, $2, $3, 10)
            `, [referral_code.toUpperCase(), referrerId, user.id]);
        }

        // Create student profile if registering as parent
        if (allowedRole === 'parent') {
            // Parent can add students later from dashboard
        }

        // Schedule first check-in 3 months from now
        await pool.query(`
            INSERT INTO checkins (student_id, due_date)
            VALUES ($1, CURRENT_DATE + INTERVAL '3 months')
        `, [user.id]);

        req.session.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.first_name,
            lastName: user.last_name,
            referralCode: user.referral_code,
        };

        req.session.success = 'Welcome to BrightMinds Tutoring!';
        res.redirect(getDashboardUrl(user.role));
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong. Please try again.';
        res.redirect('/auth/register');
    }
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

function getDashboardUrl(role) {
    switch (role) {
        case 'owner': return '/admin/owner';
        case 'tutor': return '/admin/tutor';
        case 'parent': return '/parent/dashboard';
        case 'student': return '/parent/dashboard';
        default: return '/';
    }
}

module.exports = router;
