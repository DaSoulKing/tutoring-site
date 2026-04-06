const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated, isParent } = require('../middleware/auth');

// Dashboard
router.get('/dashboard', isAuthenticated, isParent, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const bookings = await pool.query(`
            SELECT b.*, t.first_name as tutor_first, t.last_name as tutor_last, t.profile_picture as tutor_pic
            FROM bookings b JOIN users t ON b.tutor_id = t.id
            WHERE (b.student_id = $1 OR b.parent_id = $1) AND b.booking_date >= CURRENT_DATE AND b.status IN ('pending','confirmed')
            AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time LIMIT 10
        `, [userId]);
        const subscription = await pool.query(`SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [userId]);
        const unread = await pool.query('SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false', [userId]);
        const reportCards = await pool.query(`
            SELECT rc.*, t.first_name as tutor_first, t.last_name as tutor_last
            FROM report_cards rc JOIN users t ON rc.tutor_id = t.id WHERE rc.student_id = $1 ORDER BY rc.report_date DESC LIMIT 5
        `, [userId]);

        // Get assigned tutors
        const assignedTutors = await pool.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.profile_picture
            FROM bookings b JOIN users u ON b.tutor_id = u.id
            WHERE (b.student_id = $1 OR b.parent_id = $1) AND b.status IN ('pending','confirmed','completed')
        `, [userId]);

        res.render('parent/dashboard', {
            title: 'My Dashboard - BrightMinds', bookings: bookings.rows,
            subscription: subscription.rows[0] || null,
            unreadCount: parseInt(unread.rows[0].count),
            reportCards: reportCards.rows, assignedTutors: assignedTutors.rows, meta: {}
        });
    } catch (err) { console.error(err); req.session.error = 'Failed to load dashboard.'; res.redirect('/'); }
});

// Calendar
router.get('/calendar', isAuthenticated, isParent, async (req, res) => {
    try {
        const bookings = await pool.query(`
            SELECT b.*, t.first_name as tutor_first, t.last_name as tutor_last
            FROM bookings b JOIN users t ON b.tutor_id = t.id
            WHERE (b.student_id = $1 OR b.parent_id = $1) AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
            AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time
        `, [req.session.user.id]);
        res.render('parent/calendar', { title: 'My Calendar', bookings: bookings.rows, meta: {} });
    } catch (err) { console.error(err); res.redirect('/parent/dashboard'); }
});

// Messages
router.get('/messages', isAuthenticated, async (req, res) => {
    try {
        const conversations = await pool.query(`
            SELECT DISTINCT ON (other_id) * FROM (
                SELECT m.*, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END as other_id,
                    u.first_name, u.last_name, u.role, u.profile_picture
                FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
                WHERE m.sender_id = $1 OR m.receiver_id = $1 ORDER BY other_id, m.created_at DESC
            ) sub ORDER BY other_id, created_at DESC
        `, [req.session.user.id]);
        res.render('parent/messages', { title: 'Messages', conversations: conversations.rows, activeConversation: null, messages: [], meta: {} });
    } catch (err) { console.error(err); res.redirect('/parent/dashboard'); }
});

router.get('/messages/:userId', isAuthenticated, async (req, res) => {
    try {
        const otherUser = await pool.query('SELECT id, first_name, last_name, role, profile_picture FROM users WHERE id = $1', [req.params.userId]);
        await pool.query('UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2 AND is_read = false', [req.params.userId, req.session.user.id]);
        const messages = await pool.query(`
            SELECT m.*, u.first_name, u.last_name FROM messages m JOIN users u ON m.sender_id = u.id
            WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
            ORDER BY m.created_at ASC
        `, [req.session.user.id, req.params.userId]);
        const conversations = await pool.query(`
            SELECT DISTINCT ON (other_id) * FROM (
                SELECT m.*, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END as other_id,
                    u.first_name, u.last_name, u.role, u.profile_picture
                FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
                WHERE m.sender_id = $1 OR m.receiver_id = $1 ORDER BY other_id, m.created_at DESC
            ) sub ORDER BY other_id, created_at DESC
        `, [req.session.user.id]);
        res.render('parent/messages', {
            title: `Chat - BrightMinds`, conversations: conversations.rows,
            activeConversation: otherUser.rows[0] || null, messages: messages.rows, meta: {}
        });
    } catch (err) { console.error(err); res.redirect('/parent/messages'); }
});

router.post('/messages/:userId', isAuthenticated, async (req, res) => {
    try {
        await pool.query(`INSERT INTO messages (sender_id, receiver_id, body, message_type) VALUES ($1,$2,$3,'general')`, [req.session.user.id, req.params.userId, req.body.body]);
        res.redirect(`/parent/messages/${req.params.userId}`);
    } catch (err) { console.error(err); res.redirect('/parent/messages'); }
});

// Contact form
router.get('/contact', isAuthenticated, isParent, (req, res) => {
    res.render('parent/contact-form', { title: 'Contact & Inquiries', meta: {} });
});

router.post('/contact', isAuthenticated, isParent, async (req, res) => {
    try {
        const { inquiry_type, subject, message } = req.body;
        const user = req.session.user;
        await pool.query(`INSERT INTO inquiries (user_id, name, email, inquiry_type, subject, message) VALUES ($1,$2,$3,$4,$5,$6)`,
            [user.id, `${user.firstName} ${user.lastName}`, user.email, inquiry_type, subject, message]);
        req.session.success = 'Inquiry submitted!';
        res.redirect('/parent/contact');
    } catch (err) { console.error(err); req.session.error = 'Failed.'; res.redirect('/parent/contact'); }
});

// Cancel subscription
router.post('/cancel-subscription', isAuthenticated, isParent, async (req, res) => {
    try {
        await pool.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1 WHERE parent_id = $2 AND status = 'active'`, [req.body.cancel_reason, req.session.user.id]);
        req.session.success = 'Subscription cancelled.';
        res.redirect('/parent/dashboard');
    } catch (err) { console.error(err); req.session.error = 'Failed.'; res.redirect('/parent/dashboard'); }
});

// Video session
router.get('/session/:bookingId', isAuthenticated, async (req, res) => {
    try {
        const booking = await pool.query(`
            SELECT b.*, t.first_name as tutor_first, t.last_name as tutor_last
            FROM bookings b JOIN users t ON b.tutor_id = t.id
            WHERE b.id = $1 AND (b.student_id = $2 OR b.parent_id = $2 OR b.tutor_id = $2)
        `, [req.params.bookingId, req.session.user.id]);
        if (booking.rows.length === 0) { req.session.error = 'Session not found.'; return res.redirect('/parent/dashboard'); }

        const b = booking.rows[0];
        const roomId = b.meeting_room_id || `brightminds-${b.id}-${b.booking_date}`;
        if (!b.meeting_room_id) await pool.query('UPDATE bookings SET meeting_room_id = $1 WHERE id = $2', [roomId, b.id]);

        res.render('parent/video-session', {
            title: 'Video Session', booking: b, roomId: roomId,
            userName: `${req.session.user.firstName} ${req.session.user.lastName}`, meta: {}
        });
    } catch (err) { console.error(err); res.redirect('/parent/dashboard'); }
});

module.exports = router;
