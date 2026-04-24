const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated, isOwner } = require('../middleware/auth');

// Blog listing
router.get('/', async (req, res) => {
    try {
        const posts = await pool.query(`
            SELECT bp.*, u.first_name, u.last_name
            FROM blog_posts bp
            JOIN users u ON bp.author_id = u.id
            WHERE bp.is_published = true
            ORDER BY bp.published_at DESC
        `);

        res.render('blog', {
            title: 'Blog - BrainBridge',
            posts: posts.rows,
            meta: { description: 'Read our latest articles on education, learning tips, and tutoring insights.' }
        });
    } catch (err) {
        console.error(err);
        res.render('blog', { title: 'Blog', posts: [], meta: {} });
    }
});

// Single blog post
router.get('/:slug', async (req, res) => {
    try {
        const post = await pool.query(`
            SELECT bp.*, u.first_name, u.last_name
            FROM blog_posts bp
            JOIN users u ON bp.author_id = u.id
            WHERE bp.slug = $1 AND bp.is_published = true
        `, [req.params.slug]);

        if (post.rows.length === 0) {
            return res.status(404).render('error', { title: '404', message: 'Post not found.', code: 404 });
        }

        res.render('blog-post', {
            title: `${post.rows[0].title} - BrainBridge Blog`,
            post: post.rows[0],
            meta: { description: post.rows[0].excerpt || '' }
        });
    } catch (err) {
        console.error(err);
        res.redirect('/blog');
    }
});

// Create blog post (owner only)
router.post('/', isAuthenticated, isOwner, async (req, res) => {
    try {
        const { title, excerpt, content, is_published } = req.body;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        await pool.query(`
            INSERT INTO blog_posts (author_id, title, slug, excerpt, content, is_published, published_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [req.session.user.id, title, slug, excerpt, content, is_published === 'on', is_published === 'on' ? new Date() : null]);

        req.session.success = 'Blog post created!';
        res.redirect('/blog');
    } catch (err) {
        console.error(err);
        req.session.error = 'Failed to create post.';
        res.redirect('/admin/owner');
    }
});

module.exports = router;
