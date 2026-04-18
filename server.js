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

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://www.google.com", "https://www.gstatic.com", "https://meet.jit.si"],
            scriptSrcAttr: ["'unsafe-inline'"],  // Allow onclick handlers
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            frameSrc: ["https://www.google.com", "https://meet.jit.si", "https://8x8.vc"],
            connectSrc: ["'self'", "https://meet.jit.si", "https://api.resend.com"],
        },
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
}));

// Additional security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Allow camera/mic for Jitsi video sessions
    res.setHeader('Permissions-Policy', 'camera=(self "https://meet.jit.si"), microphone=(self "https://meet.jit.si"), geolocation=()');
    next();
});

app.use(compression());

// Global rate limiter
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
}));

// Stripe webhook needs raw body for signature verification - must be before JSON parser
app.use('/payment/webhook', express.raw({ type: 'application/json' }));

// Body parsing with size limits to prevent abuse
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Uploaded files: prevent MIME sniffing, force download for non-images
app.use('/uploads', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    // Force download for non-image files (resumes, docs)
    const ext = path.extname(req.path).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        res.setHeader('Content-Disposition', 'attachment');
    }
    next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0,
    etag: true,
}));

// Sessions with secure settings
app.use(session({
    store: new PgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || (() => { console.error('FATAL: SESSION_SECRET not set'); process.exit(1); })(),
    name: 'bm.sid', // Custom name instead of default 'connect.sid'
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true, // Prevents JS access to cookie
        maxAge: 8 * 60 * 60 * 1000, // 8 hours instead of 24
        sameSite: 'lax', // CSRF protection
    },
}));

// CSRF protection
const { csrfInject, csrfProtect } = require('./middleware/csrf');
app.use(csrfInject);
app.use(csrfProtect);

// Globals for views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.siteName = process.env.SITE_NAME || 'BrightMinds Tutoring';
    res.locals.siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
    res.locals.recaptchaSiteKey = process.env.RECAPTCHA_SITE_KEY || '';
    res.locals.charityName = process.env.CHARITY_NAME || 'Kids Education Fund';
    res.locals.success = req.session.success; delete req.session.success;
    res.locals.error = req.session.error; delete req.session.error;
    res.locals.resendEmail = req.session.resendEmail; delete req.session.resendEmail;
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
app.use('/payment', require('./routes/payment'));

// 404
app.use((req, res) => {
    res.status(404).render('error', { title: '404', message: 'Page not found.', code: 404 });
});

// Error handler - never leak stack traces in production
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title: '500',
        message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
        code: 500
    });
});

// Scheduled tasks
function startScheduledTasks() {
    setInterval(async () => {
        try {
            await pool.query(`UPDATE checkins SET alert_sent = true WHERE due_date <= CURRENT_DATE AND completed = false AND alert_sent = false`);
            // Clean expired sessions
            await pool.query(`DELETE FROM session WHERE expire < NOW()`);
            // Clean expired reset tokens
            await pool.query(`UPDATE users SET reset_token = NULL, reset_expires = NULL WHERE reset_expires < NOW() AND reset_token IS NOT NULL`);
            // Clean expired verification tokens (older than 24h)
            await pool.query(`UPDATE users SET verify_token = NULL WHERE verify_token IS NOT NULL AND created_at < NOW() - INTERVAL '24 hours' AND email_verified = false`);
        } catch (err) { console.error('Scheduled task error:', err.message); }
    }, 60 * 60 * 1000);
}

app.listen(PORT, () => {
    console.log(`BrightMinds running on port ${PORT}`);
    startScheduledTasks();
});

module.exports = app;
