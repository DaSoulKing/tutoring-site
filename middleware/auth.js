function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    req.session.error = 'Please log in to continue.';
    req.session.returnTo = req.originalUrl;
    res.redirect('/auth/login');
}

function isOwner(req, res, next) {
    if (req.session.user && req.session.user.role === 'owner') {
        return next();
    }
    req.session.error = 'Access denied. Owner privileges required.';
    res.redirect('/');
}

function isTutor(req, res, next) {
    if (req.session.user && (req.session.user.role === 'tutor' || req.session.user.role === 'owner')) {
        return next();
    }
    req.session.error = 'Access denied. Tutor privileges required.';
    res.redirect('/');
}

function isParent(req, res, next) {
    if (req.session.user && (req.session.user.role === 'parent' || req.session.user.role === 'student')) {
        return next();
    }
    req.session.error = 'Access denied.';
    res.redirect('/');
}

function isOwnerOrTutor(req, res, next) {
    if (req.session.user && (req.session.user.role === 'owner' || req.session.user.role === 'tutor')) {
        return next();
    }
    req.session.error = 'Access denied.';
    res.redirect('/');
}

module.exports = { isAuthenticated, isOwner, isTutor, isParent, isOwnerOrTutor };
