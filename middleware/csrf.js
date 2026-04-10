const crypto = require('crypto');

function csrfToken(req) {
    if (!req.session._csrf) {
        req.session._csrf = crypto.randomBytes(32).toString('hex');
    }
    return req.session._csrf;
}

function csrfInject(req, res, next) {
    res.locals.csrfToken = csrfToken(req);
    next();
}

function csrfProtect(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const token = req.body?._csrf || req.headers['x-csrf-token'];
    const sessionToken = req.session?._csrf;

    if (!token || !sessionToken) return csrfFail(req, res);

    const tokenBuf = Buffer.from(String(token));
    const sessionBuf = Buffer.from(String(sessionToken));
    if (tokenBuf.length !== sessionBuf.length || !crypto.timingSafeEqual(tokenBuf, sessionBuf)) {
        return csrfFail(req, res);
    }
    next();
}

function csrfFail(req, res) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.path.startsWith('/api/')) {
        return res.status(403).json({ success: false, message: 'Invalid or missing security token.' });
    }
    req.session.error = 'Invalid form submission. Please try again.';
    const ref = req.headers.referer;
    return res.redirect((ref && !ref.includes('://') === false) ? ref : '/');
}

module.exports = { csrfInject, csrfProtect };
