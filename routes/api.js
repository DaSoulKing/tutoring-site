const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Rate limits for API actions
const bookingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { success: false, message: 'Too many requests. Try again later.' } });
const messageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { success: false, message: 'Too many messages. Slow down.' } });

// Validate integer params
router.param('id', (req, res, next, val) => { if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid ID' }); next(); });
router.param('tutorId', (req, res, next, val) => { if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid ID' }); next(); });

// Calendar events
router.get('/calendar/events', isAuthenticated, async (req, res) => {
    try {
        const { month, year } = req.query;
        const userId = req.session.user.id;
        const role = req.session.user.role;
        let query, params;

        if (role === 'owner') {
            query = `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       t.first_name as tutor_first, t.last_name as tutor_last,
                       s.first_name as student_first, s.last_name as student_last
                FROM bookings b JOIN users t ON b.tutor_id = t.id JOIN users s ON b.student_id = s.id
                WHERE EXTRACT(MONTH FROM b.booking_date) = $1 AND EXTRACT(YEAR FROM b.booking_date) = $2
                AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time`;
            params = [month, year];
        } else if (role === 'tutor') {
            query = `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       s.first_name as student_first, s.last_name as student_last
                FROM bookings b JOIN users s ON b.student_id = s.id
                WHERE b.tutor_id = $1 AND EXTRACT(MONTH FROM b.booking_date) = $2 AND EXTRACT(YEAR FROM b.booking_date) = $3
                AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time`;
            params = [userId, month, year];
        } else {
            query = `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       t.first_name as tutor_first, t.last_name as tutor_last
                FROM bookings b JOIN users t ON b.tutor_id = t.id
                WHERE (b.student_id = $1 OR b.parent_id = $1) AND EXTRACT(MONTH FROM b.booking_date) = $2 AND EXTRACT(YEAR FROM b.booking_date) = $3
                AND b.subject != 'Assigned by Admin' ORDER BY b.booking_date, b.start_time`;
            params = [userId, month, year];
        }
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Tutor availability (public - only shows recurring schedule, not specific bookings)
router.get('/tutor/:tutorId/availability', async (req, res) => {
    try {
        const tutorId = parseInt(req.params.tutorId, 10);
        if (isNaN(tutorId)) return res.status(400).json({ error: 'Invalid ID' });
        const availability = await pool.query('SELECT day_of_week, start_time, end_time FROM tutor_availability WHERE tutor_id = $1 AND is_recurring = true ORDER BY day_of_week, start_time', [tutorId]);
        res.json({ availability: availability.rows });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Create booking
router.post('/bookings', isAuthenticated, bookingLimiter, async (req, res) => {
    try {
        const { tutor_id, booking_date, start_time, end_time, subject } = req.body;
        const conflict = await pool.query(`SELECT id FROM bookings WHERE tutor_id = $1 AND booking_date = $2 AND status IN ('pending','confirmed') AND (start_time, end_time) OVERLAPS ($3::time, $4::time)`, [tutor_id, booking_date, start_time, end_time]);
        if (conflict.rows.length > 0) return res.json({ success: false, message: 'This time slot is already booked.' });

        const crypto = require('crypto');
        const roomId = `bm-${crypto.randomBytes(16).toString('hex')}`;
        const result = await pool.query(`INSERT INTO bookings (tutor_id, student_id, parent_id, booking_date, start_time, end_time, subject, meeting_room_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
            [tutor_id, req.session.user.id, req.session.user.id, booking_date, start_time, end_time, subject, roomId]);
        res.json({ success: true, bookingId: result.rows[0].id, message: 'Booking request submitted!' });
    } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// Cancel booking
router.post('/bookings/:id/cancel', isAuthenticated, bookingLimiter, async (req, res) => {
    try {
        const booking = await pool.query('SELECT * FROM bookings WHERE id = $1 AND (student_id = $2 OR parent_id = $2 OR tutor_id = $2)', [req.params.id, req.session.user.id]);
        if (booking.rows.length === 0) return res.json({ success: false, message: 'Booking not found.' });

        const b = booking.rows[0];
        const bookingDateTime = new Date(`${b.booking_date}T${b.start_time}`);
        const hoursUntil = (bookingDateTime - new Date()) / (1000 * 60 * 60);
        const lateCancel = hoursUntil < 24;

        await pool.query(`UPDATE bookings SET status = 'cancelled', cancel_reason = $1, cancelled_at = NOW(), late_cancel = $2 WHERE id = $3`, [req.body.reason || '', lateCancel, req.params.id]);
        res.json({ success: true, lateCancel, message: lateCancel ? 'Cancelled. Note: Cancellations within 24 hours may incur a fee.' : 'Booking cancelled.' });
    } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// Confirm booking
router.post('/bookings/:id/confirm', isAuthenticated, bookingLimiter, async (req, res) => {
    try {
        await pool.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1 AND tutor_id = $2", [req.params.id, req.session.user.id]);
        try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [req.session.user.id, 'booking_confirmed', 'Booking #' + req.params.id]); } catch(e) {}
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.json({ success: true });
        }
        req.session.success = 'Session confirmed!';
        res.redirect(req.headers.referer || '/admin/tutor');
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// Unread messages
router.get('/messages/unread', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false', [req.session.user.id]);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) { res.json({ count: 0 }); }
});

// Send message (with authorization check)
router.post('/messages', isAuthenticated, messageLimiter, async (req, res) => {
    try {
        const { receiver_id, body, message_type } = req.body;
        const senderId = req.session.user.id;
        const receiverId = parseInt(receiver_id);
        if (isNaN(receiverId) || receiverId === senderId) return res.status(400).json({ success: false, message: 'Invalid recipient.' });

        // Check relationship exists
        const rel = await pool.query(`
            SELECT 1 FROM bookings WHERE (tutor_id = $1 AND (student_id = $2 OR parent_id = $2))
                OR (tutor_id = $2 AND (student_id = $1 OR parent_id = $1))
            UNION SELECT 1 FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
            UNION SELECT 1 FROM users WHERE id = $2 AND role = 'owner'
            LIMIT 1
        `, [senderId, receiverId]);
        if (rel.rows.length === 0) return res.status(403).json({ success: false, message: 'Not authorized to message this user.' });

        const safeBody = (body || '').trim().substring(0, 5000)
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '')  // emoticons
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')  // misc symbols
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')  // transport
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')  // flags
            .replace(/[\u{2600}-\u{26FF}]/gu, '')     // misc symbols
            .replace(/[\u{2700}-\u{27BF}]/gu, '')     // dingbats
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')     // variation selectors
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')   // supplemental
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')   // chess symbols
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')   // symbols extended
            .replace(/[\u{200D}]/gu, '')               // zero width joiner
            .replace(/\s{2,}/g, ' ')                   // collapse double spaces from removed emojis
            .trim();
        if (!safeBody) return res.status(400).json({ success: false, message: 'Message cannot be empty (emojis are not allowed).' });

        const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, body, message_type) VALUES ($1,$2,$3,$4) RETURNING *`,
            [senderId, receiverId, safeBody, message_type || 'general']);
        res.json({ success: true, message: result.rows[0] });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// Fetch conversation messages (for polling)
router.get('/messages/conversation/:userId', isAuthenticated, async (req, res) => {
    try {
        const myId = req.session.user.id;
        const otherId = parseInt(req.params.userId, 10);
        if (isNaN(otherId)) return res.status(400).json([]);
        const messages = await pool.query(
            `SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY created_at ASC`,
            [myId, otherId]
        );
        // Mark as read
        await pool.query('UPDATE messages SET is_read = true WHERE receiver_id = $1 AND sender_id = $2 AND is_read = false', [myId, otherId]);
        res.json(messages.rows);
    } catch (err) { console.error(err); res.json([]); }
});

module.exports = router;
