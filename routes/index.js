const router = require('express').Router();
const pool = require('../db/pool');
const { verifyRecaptcha } = require('../middleware/recaptcha');
const multer = require('multer');
const path = require('path');

// File upload config for applications
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
}});

// Home page
router.get('/', async (req, res) => {
    try {
        // Get featured tutors for carousel
        const tutorsResult = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.profile_picture,
                   tp.bio, tp.tagline, tp.subjects, tp.carousel_description
            FROM users u
            JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.is_active = true AND tp.approved = true AND tp.is_featured = true
            ORDER BY RANDOM() LIMIT 10
        `);

        res.render('home', {
            title: 'BrightMinds Tutoring - Where Learning Comes Alive',
            tutors: tutorsResult.rows,
            meta: {
                description: 'BrightMinds Tutoring offers personalized, engaging tutoring for students of all ages. Our expert tutors help kids reach their full potential. 3% of every payment goes to charity.',
                keywords: 'tutoring, education, kids tutoring, online tutoring, math tutor, science tutor'
            }
        });
    } catch (err) {
        console.error(err);
        res.render('home', { title: 'BrightMinds Tutoring', tutors: [], meta: {} });
    }
});

// About us
router.get('/about', async (req, res) => {
    try {
        const owners = await pool.query(`
            SELECT u.first_name, u.last_name, u.profile_picture
            FROM users u WHERE u.role = 'owner' AND u.is_active = true
        `);
        const tutors = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.profile_picture,
                   tp.bio, tp.tagline, tp.subjects, tp.experience_years
            FROM users u
            JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.is_active = true AND tp.approved = true
            ORDER BY tp.is_featured DESC, u.first_name
        `);

        res.render('about', {
            title: 'About Us - BrightMinds Tutoring',
            owners: owners.rows,
            tutors: tutors.rows,
            meta: { description: 'Meet the passionate team behind BrightMinds Tutoring.' }
        });
    } catch (err) {
        console.error(err);
        res.render('about', { title: 'About Us', owners: [], tutors: [], meta: {} });
    }
});

// Contact
router.get('/contact', (req, res) => {
    res.render('contact', {
        title: 'Contact Us - BrightMinds Tutoring',
        meta: { description: 'Get in touch with BrightMinds Tutoring. We are here to help with any questions or concerns.' }
    });
});

router.post('/contact', verifyRecaptcha, async (req, res) => {
    try {
        const { name, email, phone, inquiry_type, subject, message } = req.body;
        await pool.query(`
            INSERT INTO inquiries (user_id, name, email, phone, inquiry_type, subject, message)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [req.session.user?.id || null, name, email, phone || null, inquiry_type || 'general', subject, message]);

        // Email notification would go here via nodemailer
        req.session.success = 'Your message has been sent! We will get back to you soon.';
        res.redirect('/contact');
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong. Please try again.';
        res.redirect('/contact');
    }
});

// Services
router.get('/services', (req, res) => {
    res.render('services', {
        title: 'Our Services - BrightMinds Tutoring',
        meta: { description: 'Explore our tutoring services including one-on-one sessions, group learning, and more.' }
    });
});

// Consultation booking
router.get('/consultation', (req, res) => {
    res.render('consultation', {
        title: 'Book a Free Consultation - BrightMinds Tutoring',
        meta: { description: 'Book a free consultation call to discuss your child\'s learning needs.' }
    });
});

router.post('/consultation', verifyRecaptcha, async (req, res) => {
    try {
        const { name, email, phone, child_grade, subjects, preferred_time, message } = req.body;
        await pool.query(`
            INSERT INTO inquiries (name, email, phone, inquiry_type, subject, message)
            VALUES ($1, $2, $3, 'inquiry', $4, $5)
        `, [name, email, phone, 'Free Consultation Request', `Grade: ${child_grade}, Subjects: ${subjects}, Preferred Time: ${preferred_time}. ${message || ''}`]);

        req.session.success = 'Your consultation request has been submitted! We will contact you within 24 hours.';
        res.redirect('/consultation');
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong. Please try again.';
        res.redirect('/consultation');
    }
});

// Employment / Apply
router.get('/employment', (req, res) => {
    res.render('employment', {
        title: 'Join Our Team - BrightMinds Tutoring',
        meta: { description: 'Apply to become a tutor or register as a student at BrightMinds Tutoring.' }
    });
});

router.post('/employment', upload.single('resume'), verifyRecaptcha, async (req, res) => {
    try {
        const { applicant_type, first_name, last_name, email, phone, subjects, experience, education, availability, why_join, cover_letter } = req.body;
        const resumePath = req.file ? '/uploads/' + req.file.filename : null;
        const subjectsArray = subjects ? subjects.split(',').map(s => s.trim()) : [];

        await pool.query(`
            INSERT INTO applications (applicant_type, first_name, last_name, email, phone, resume_path, cover_letter, subjects, experience, education, availability, why_join)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [applicant_type, first_name, last_name, email, phone, resumePath, cover_letter, subjectsArray, experience, education, availability, why_join]);

        req.session.success = 'Your application has been submitted! We will review it and get back to you.';
        res.redirect('/employment');
    } catch (err) {
        console.error(err);
        req.session.error = 'Something went wrong. Please try again.';
        res.redirect('/employment');
    }
});

// Terms and Conditions
router.get('/terms', (req, res) => {
    res.render('terms', {
        title: 'Terms & Conditions - BrightMinds Tutoring',
        meta: { description: 'Read our terms of service, rules, and regulations for BrightMinds Tutoring.' }
    });
});

// Charity page
router.get('/charity', (req, res) => {
    res.render('charity', {
        title: 'Our Charity Mission - BrightMinds Tutoring',
        meta: { description: 'Learn about our commitment to giving back. 3% of every payment goes to the Kids Education Fund.' }
    });
});

// Checkout
router.get('/checkout', (req, res) => {
    res.render('checkout', {
        title: 'Checkout - BrightMinds Tutoring',
        meta: { description: 'Complete your purchase with BrightMinds Tutoring.' }
    });
});

router.post('/checkout/apply-referral', async (req, res) => {
    try {
        const { referral_code } = req.body;
        const result = await pool.query(
            'SELECT id, first_name, referral_code FROM users WHERE referral_code = $1 AND is_active = true',
            [referral_code.toUpperCase()]
        );

        if (result.rows.length > 0) {
            // Don't let users use their own code
            if (req.session.user && result.rows[0].id === req.session.user.id) {
                return res.json({ success: false, message: 'You cannot use your own referral code.' });
            }
            return res.json({ success: true, discount: 10, message: 'Referral code applied! 10% discount.' });
        }
        res.json({ success: false, message: 'Invalid referral code.' });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Something went wrong.' });
    }
});

module.exports = router;
