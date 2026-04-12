/**
 * Centralized email utility.
 * Compatible with nodemailer v8.0.5+ (strict input validation required).
 * 
 * Primary: nodemailer SMTP (free, set SMTP_HOST + SMTP_USER + SMTP_PASS)
 * Fallback: Resend HTTP API (free 100/day, set RESEND_API_KEY)
 * 
 * Gmail SMTP setup:
 *   1. Enable 2FA on your Google account
 *   2. Go to https://myaccount.google.com/apppasswords
 *   3. Create an app password (select "Mail" and "Other")
 *   4. Set SMTP_HOST=smtp.gmail.com, SMTP_PORT=587
 *   5. Set SMTP_USER=your@gmail.com, SMTP_PASS=theapppassword (no spaces)
 *   6. Set EMAIL_FROM=your@gmail.com
 */

// --- Nodemailer v8 requires strict input sanitization ---
function cleanEmail(input) {
    if (typeof input !== 'string') return '';
    return input.trim().replace(/[\r\n\t]/g, '').slice(0, 320);
}

function cleanSubject(input) {
    if (typeof input !== 'string') return '';
    return input.trim().replace(/[\r\n]/g, '').slice(0, 998);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendEmail(to, subject, html) {
    // Sanitize inputs (required for nodemailer v8)
    const cleanTo = cleanEmail(to);
    const cleanSubj = cleanSubject(subject);

    if (!cleanTo || !isValidEmail(cleanTo)) {
        console.error('EMAIL SKIPPED: Invalid recipient:', to);
        return false;
    }

    // Try Resend first (HTTP API, works on all cloud hosts)
    if (process.env.RESEND_API_KEY) {
        return sendViaResend(cleanTo, cleanSubj, html);
    }

    // Fall back to SMTP (only works if port 587/465 isn't blocked)
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        return sendViaSMTP(cleanTo, cleanSubj, html);
    }

    console.log('EMAIL SKIPPED: No provider configured. Set SMTP_HOST/USER/PASS or RESEND_API_KEY');
    return false;
}

async function sendViaSMTP(to, subject, html) {
    try {
        const nodemailer = require('nodemailer');
        const port = parseInt(process.env.SMTP_PORT, 10) || 587;

        // Validate credentials exist (v8 throws on missing auth)
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            throw new Error('Missing SMTP credentials');
        }

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: port === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false,
            },
            // Always log in production too so Railway logs show email issues
            logger: true,
            debug: process.env.NODE_ENV !== 'production',
        });

        const fromAddr = cleanEmail(process.env.EMAIL_FROM || process.env.SMTP_USER);

        const info = await transporter.sendMail({
            from: fromAddr,
            to,
            subject,
            html,
        });

        console.log('Email sent via SMTP:', info.messageId, 'to:', to);
        return true;
    } catch (err) {
        console.error('SMTP email failed:', err.message);
        if (err.message.includes('Invalid login') || err.message.includes('authentication')) {
            console.error('HINT: For Gmail, enable 2FA then create App Password at https://myaccount.google.com/apppasswords');
            console.error('HINT: SMTP_PASS must have NO spaces. Current length:', (process.env.SMTP_PASS || '').length);
        }
        if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT')) {
            console.error('HINT: SMTP port', process.env.SMTP_PORT, 'may be blocked on this host.');
        }
        if (err.message.includes('Invalid') || err.message.includes('rejected')) {
            console.error('HINT: Nodemailer v8 has strict validation. Check email format and headers.');
        }
        return false;
    }
}

async function sendViaResend(to, subject, html) {
    try {
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: process.env.EMAIL_FROM || 'BrightMinds <onboarding@resend.dev>',
                to: [to],
                subject,
                html,
            }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            console.error('Resend API error:', resp.status, err);
            return false;
        }

        const data = await resp.json();
        console.log('Email sent via Resend:', data.id, 'to:', to);
        return true;
    } catch (err) {
        console.error('Resend error:', err.message);
        return false;
    }
}

async function testEmail(to) {
    console.log('--- EMAIL TEST ---');
    console.log('SMTP_HOST:', process.env.SMTP_HOST || '(not set)');
    console.log('SMTP_PORT:', process.env.SMTP_PORT || '(not set, default 587)');
    console.log('SMTP_USER:', process.env.SMTP_USER || '(not set)');
    console.log('SMTP_PASS length:', (process.env.SMTP_PASS || '').length);
    console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'set (' + process.env.RESEND_API_KEY.length + ' chars)' : '(not set)');
    console.log('EMAIL_FROM:', process.env.EMAIL_FROM || '(not set)');
    console.log('Sending to:', to);
    console.log('---');

    const result = await sendEmail(
        to,
        'BrightMinds Email Test',
        '<h2>Email is working!</h2><p>If you see this, your email configuration is correct.</p><p>Sent at: ' + new Date().toISOString() + '</p>'
    );

    console.log('--- EMAIL TEST RESULT:', result ? 'SUCCESS' : 'FAILED', '---');
    return result;
}

module.exports = { sendEmail, testEmail };
