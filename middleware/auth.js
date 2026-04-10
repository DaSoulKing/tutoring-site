function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        req.session.touch();
        return next();
    }
    req.session.error = 'Please log in to continue.';
    // Validate returnTo is a safe local path
    const url = req.originalUrl;
    if (url && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) {
        req.session.returnTo = url;
    }
    res.redirect('/auth/login');
}

// Validate that :id, :userId, :bookingId, :studentId params are integers
function validateIntParam(...paramNames) {
    return (req, res, next) => {
        for (const name of paramNames) {
            if (req.params[name] !== undefined) {
                const val = parseInt(req.params[name], 10);
                if (isNaN(val) || val < 1 || String(val) !== req.params[name]) {
                    return res.status(400).render('error', { title: '400', message: 'Invalid request.', code: 400 });
                }
            }
        }
        next();
    };
}

function isOwner(req, res, next) {
    if (req.session.user && req.session.user.role === 'owner') return next();
    req.session.error = 'Access denied.';
    res.redirect('/');
}

function isTutor(req, res, next) {
    if (req.session.user && (req.session.user.role === 'tutor' || req.session.user.role === 'owner')) return next();
    req.session.error = 'Access denied.';
    res.redirect('/');
}

function isParent(req, res, next) {
    if (req.session.user && (req.session.user.role === 'parent' || req.session.user.role === 'student')) return next();
    req.session.error = 'Access denied.';
    res.redirect('/');
}

function isOwnerOrTutor(req, res, next) {
    if (req.session.user && (req.session.user.role === 'owner' || req.session.user.role === 'tutor')) return next();
    req.session.error = 'Access denied.';
    res.redirect('/');
}

module.exports = { isAuthenticated, isOwner, isTutor, isParent, isOwnerOrTutor, validateIntParam };
