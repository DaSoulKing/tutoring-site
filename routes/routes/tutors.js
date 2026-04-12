const router = require('express').Router();
const pool = require('../db/pool');

// List all tutors with filters
router.get('/', async (req, res) => {
    try {
        const { subject, search } = req.query;
        let query = `
            SELECT u.id, u.first_name, u.last_name, u.profile_picture,
                   tp.bio, tp.tagline, tp.subjects, tp.experience_years,
                   tp.education, tp.hourly_rate
            FROM users u
            JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.is_active = true AND tp.approved = true
        `;
        const params = [];

        if (subject) {
            params.push(subject);
            query += ` AND $${params.length} = ANY(tp.subjects)`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR tp.bio ILIKE $${params.length})`;
        }

        query += ' ORDER BY tp.is_featured DESC, u.first_name';

        const tutorsResult = await pool.query(query, params);

        // Get unique subjects for filter
        const subjectsResult = await pool.query(`
            SELECT DISTINCT unnest(tp.subjects) as subject
            FROM tutor_profiles tp
            JOIN users u ON tp.user_id = u.id
            WHERE u.is_active = true AND tp.approved = true
            ORDER BY subject
        `);

        res.render('tutors', {
            title: 'Our Tutors - BrightMinds Tutoring',
            tutors: tutorsResult.rows,
            subjects: subjectsResult.rows.map(r => r.subject),
            activeSubject: subject || '',
            search: search || '',
            meta: { description: 'Browse our expert tutors. Filter by subject to find the perfect match for your child.' }
        });
    } catch (err) {
        console.error(err);
        res.render('tutors', { title: 'Our Tutors', tutors: [], subjects: [], activeSubject: '', search: '', meta: {} });
    }
});

// Get tutor details (AJAX)
router.get('/:id/details', async (req, res) => {
    try {
        const tutor = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.profile_picture,
                   tp.bio, tp.tagline, tp.subjects, tp.experience_years,
                   tp.education, tp.hourly_rate
            FROM users u
            JOIN tutor_profiles tp ON u.id = tp.user_id
            WHERE u.id = $1 AND u.is_active = true AND tp.approved = true
        `, [req.params.id]);

        if (tutor.rows.length === 0) {
            return res.status(404).json({ error: 'Tutor not found' });
        }

        // Get availability
        const availability = await pool.query(`
            SELECT day_of_week, start_time, end_time
            FROM tutor_availability
            WHERE tutor_id = $1 AND is_recurring = true
            ORDER BY day_of_week, start_time
        `, [req.params.id]);

        // Get upcoming booked sessions (to show busy times)
        const bookings = await pool.query(`
            SELECT booking_date, start_time, end_time
            FROM bookings
            WHERE tutor_id = $1
            AND booking_date >= CURRENT_DATE
            AND status IN ('pending', 'confirmed')
            ORDER BY booking_date, start_time
        `, [req.params.id]);

        res.json({
            tutor: tutor.rows[0],
            availability: availability.rows,
            bookings: bookings.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
