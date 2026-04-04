require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway
app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://www.google.com", "https://www.gstatic.com", "https://meet.jit.si"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            frameSrc: ["https://www.google.com", "https://meet.jit.si", "https://8x8.vc"],
            connectSrc: ["'self'", "https://meet.jit.si"],
        },
    },
}));

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0,
    etag: true,
}));

// Sessions
app.use(session({
    store: new PgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'brightminds-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax',
    },
}));

// Make user and helpers available to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.siteName = 'BrightMinds Tutoring';
    res.locals.siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
    res.locals.recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || '';
    res.locals.charityName = process.env.CHARITY_NAME || 'Kids Education Fund';
    res.locals.charityPercent = 3;
    res.locals.success = req.session.success; delete req.session.success;
    res.locals.error = req.session.error; delete req.session.error;
    next();
});

// Routes
app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/tutors', require('./routes/tutors'));
app.use('/admin', require('./routes/admin'));
app.use('/parent', require('./routes/parent'));
app.use('/api', require('./routes/api'));
app.use('/blog', require('./routes/blog'));

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Page Not Found',
        message: 'Oops! The page you are looking for does not exist.',
        code: 404
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title: '500 - Server Error',
        message: 'Something went wrong on our end. Please try again later.',
        code: 500
    });
});

// Scheduled tasks: check-in alerts and payment reminders
function startScheduledTasks() {
    // Run every hour
    setInterval(async () => {
        try {
            // Check for 3-month check-ins due
            const checkinResult = await pool.query(`
                SELECT c.*, u.first_name, u.last_name, p.email as parent_email
                FROM checkins c
                JOIN users u ON c.student_id = u.id
                LEFT JOIN users p ON c.parent_id = p.id
                WHERE c.due_date <= CURRENT_DATE
                AND c.completed = false
                AND c.alert_sent = false
            `);

            for (const checkin of checkinResult.rows) {
                await pool.query(
                    'UPDATE checkins SET alert_sent = true WHERE id = $1',
                    [checkin.id]
                );
                console.log(`Check-in alert: ${checkin.first_name} ${checkin.last_name} is due for a 3-month check-in`);
            }

            // Check for payment reminders
            const paymentResult = await pool.query(`
                SELECT s.*, u.first_name, u.last_name, u.email, u.phone
                FROM subscriptions s
                JOIN users u ON s.parent_id = u.id
                WHERE s.next_billing_date <= CURRENT_DATE + INTERVAL '3 days'
                AND s.status = 'active'
                AND NOT EXISTS (
                    SELECT 1 FROM payment_reminders pr
                    WHERE pr.subscription_id = s.id
                    AND pr.reminder_date = CURRENT_DATE
                    AND pr.sent = true
                )
            `);

            for (const sub of paymentResult.rows) {
                await pool.query(`
                    INSERT INTO payment_reminders (subscription_id, parent_id, reminder_date, sent, sent_at, reminder_type)
                    VALUES ($1, $2, CURRENT_DATE, true, NOW(), 'upcoming')
                `, [sub.id, sub.parent_id]);
                console.log(`Payment reminder: ${sub.first_name} ${sub.last_name} - billing on ${sub.next_billing_date}`);
            }
        } catch (err) {
            console.error('Scheduled task error:', err);
        }
    }, 60 * 60 * 1000); // every hour
}

app.listen(PORT, () => {
    console.log(`BrightMinds Tutoring running on port ${PORT}`);
    startScheduledTasks();
});

module.exports = app;
