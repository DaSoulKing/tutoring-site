const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated } = require('../middleware/auth');

// Get calendar events for a month
router.get('/calendar/events', isAuthenticated, async (req, res) => {
    try {
        const { month, year } = req.query;
        const userId = req.session.user.id;
        const role = req.session.user.role;

        let query;
        let params;

        if (role === 'owner') {
            query = `
                SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       t.first_name as tutor_first, t.last_name as tutor_last,
                       s.first_name as student_first, s.last_name as student_last
                FROM bookings b
                JOIN users t ON b.tutor_id = t.id
                JOIN users s ON b.student_id = s.id
                WHERE EXTRACT(MONTH FROM b.booking_date) = $1
                AND EXTRACT(YEAR FROM b.booking_date) = $2
                ORDER BY b.booking_date, b.start_time
            `;
            params = [month, year];
        } else if (role === 'tutor') {
            query = `
                SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       s.first_name as student_first, s.last_name as student_last
                FROM bookings b
                JOIN users s ON b.student_id = s.id
                WHERE b.tutor_id = $1
                AND EXTRACT(MONTH FROM b.booking_date) = $2
                AND EXTRACT(YEAR FROM b.booking_date) = $3
                ORDER BY b.booking_date, b.start_time
            `;
            params = [userId, month, year];
        } else {
            query = `
                SELECT b.id, b.booking_date, b.start_time, b.end_time, b.subject, b.status, b.meeting_room_id,
                       t.first_name as tutor_first, t.last_name as tutor_last
                FROM bookings b
                JOIN users t ON b.tutor_id = t.id
                WHERE (b.student_id = $1 OR b.parent_id = $1)
                AND EXTRACT(MONTH FROM b.booking_date) = $2
                AND EXTRACT(YEAR FROM b.booking_date) = $3
                ORDER BY b.booking_date, b.start_time
            `;
            params = [userId, month, year];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get tutor availability for calendar
router.get('/tutor/:tutorId/availability', async (req, res) => {
    try {
        const availability = await pool.query(`
            SELECT * FROM tutor_availability
            WHERE tutor_id = $1 AND is_recurring = true
            ORDER BY day_of_week, start_time
        `, [req.params.tutorId]);

        const bookings = await pool.query(`
            SELECT booking_date, start_time, end_time, status
            FROM bookings
            WHERE tutor_id = $1 AND booking_date >= CURRENT_DATE AND status IN ('pending', 'confirmed')
        `, [req.params.tutorId]);

        res.json({ availability: availability.rows, bookings: bookings.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create booking request
router.post('/bookings', isAuthenticated, async (req, res) => {
    try {
        const { tutor_id, booking_date, start_time, end_time, subject } = req.body;

        // Check for conflicts
        const conflict = await pool.query(`
            SELECT id FROM bookings
            WHERE tutor_id = $1 AND booking_date = $2
            AND status IN ('pending', 'confirmed')
            AND (start_time, end_time) OVERLAPS ($3::time, $4::time)
        `, [tutor_id, booking_date, start_time, end_time]);

        if (conflict.rows.length > 0) {
            return res.json({ success: false, message: 'This time slot is already booked.' });
        }

        const roomId = `brightminds-${Date.now()}`;
        const result = await pool.query(`
            INSERT INTO bookings (tutor_id, student_id, parent_id, booking_date, start_time, end_time, subject, meeting_room_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
            RETURNING id
        `, [tutor_id, req.session.user.id, req.session.user.id, booking_date, start_time, end_time, subject, roomId]);

        res.json({ success: true, bookingId: result.rows[0].id, message: 'Booking request submitted! The tutor will confirm shortly.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Cancel booking
router.post('/bookings/:id/cancel', isAuthenticated, async (req, res) => {
    try {
        const booking = await pool.query(
            'SELECT * FROM bookings WHERE id = $1 AND (student_id = $2 OR parent_id = $2 OR tutor_id = $2)',
            [req.params.id, req.session.user.id]
        );

        if (booking.rows.length === 0) {
            return res.json({ success: false, message: 'Booking not found.' });
        }

        const b = booking.rows[0];
        const bookingDateTime = new Date(`${b.booking_date}T${b.start_time}`);
        const now = new Date();
        const hoursUntil = (bookingDateTime - now) / (1000 * 60 * 60);
        const lateCancel = hoursUntil < 24;

        await pool.query(`
            UPDATE bookings SET status = 'cancelled', cancel_reason = $1, cancelled_at = NOW(), late_cancel = $2
            WHERE id = $3
        `, [req.body.reason || '', lateCancel, req.params.id]);

        res.json({
            success: true,
            lateCancel,
            message: lateCancel
                ? 'Booking cancelled. Note: Cancellations within 24 hours may incur a fee per our terms.'
                : 'Booking cancelled successfully.'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Confirm booking (tutor)
router.post('/bookings/:id/confirm', isAuthenticated, async (req, res) => {
    try {
        await pool.query(
            "UPDATE bookings SET status = 'confirmed' WHERE id = $1 AND tutor_id = $2",
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// Get unread message count
router.get('/messages/unread', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false',
            [req.session.user.id]
        );
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// Send message (API)
router.post('/messages', isAuthenticated, async (req, res) => {
    try {
        const { receiver_id, body, message_type } = req.body;
        const result = await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, body, message_type)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [req.session.user.id, receiver_id, body, message_type || 'general']);

        res.json({ success: true, message: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

module.exports = router;
