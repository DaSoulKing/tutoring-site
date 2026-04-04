const https = require('https');

async function verifyRecaptcha(req, res, next) {
    const token = req.body['g-recaptcha-response'];
    const secret = process.env.RECAPTCHA_SECRET_KEY;

    if (!secret) {
        // Skip recaptcha if not configured
        return next();
    }

    if (!token) {
        req.session.error = 'Please complete the reCAPTCHA verification.';
        return res.redirect('back');
    }

    try {
        const url = `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`;
        const response = await fetch(url, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            return next();
        } else {
            req.session.error = 'reCAPTCHA verification failed. Please try again.';
            return res.redirect('back');
        }
    } catch (err) {
        console.error('reCAPTCHA error:', err);
        return next(); // Allow through on error
    }
}

module.exports = { verifyRecaptcha };
