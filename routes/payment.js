const router = require('express').Router();
const pool = require('../db/pool');
const { isAuthenticated } = require('../middleware/auth');

// Initialize Stripe only if key is set
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Monthly subscription payment page
router.get('/pay', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);
        const user = await pool.query('SELECT payment_status FROM users WHERE id = $1', [userId]);

        res.render('parent/payment', {
            title: 'Payment',
            subscription: sub.rows[0] || null,
            paymentStatus: user.rows[0] ? user.rows[0].payment_status : 'unpaid',
            stripeEnabled: !!process.env.STRIPE_SECRET_KEY,
            meta: {}
        });
    } catch (err) { console.error(err); res.redirect('/parent/dashboard'); }
});

// Create Stripe Checkout session for monthly payment
router.post('/pay/monthly', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) { req.session.error = 'Online payments are not configured yet. Please pay via Zelle.'; return res.redirect('/parent/pay'); }

        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);
        if (!sub.rows[0] || !sub.rows[0].rate_total) {
            req.session.error = 'No active plan found. Contact us to set up your plan.';
            return res.redirect('/parent/pay');
        }

        const amount = Math.round(parseFloat(sub.rows[0].rate_total) * 100); // cents
        const serviceFee = Math.round(amount * 0.03); // 3% service fee for Stripe
        const total = amount + serviceFee;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: sub.rows[0].plan_name + ' - Monthly Payment',
                        description: sub.rows[0].sessions_per_month + ' sessions/month',
                    },
                    unit_amount: total,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: (process.env.SITE_URL || 'http://localhost:3000') + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: (process.env.SITE_URL || 'http://localhost:3000') + '/payment/pay',
            metadata: {
                user_id: String(userId),
                payment_type: 'monthly',
                plan_name: sub.rows[0].plan_name,
            },
        });

        res.redirect(303, session.url);
    } catch (err) {
        console.error('Stripe error:', err.message);
        req.session.error = 'Payment failed: ' + err.message;
        res.redirect('/parent/pay');
    }
});

// Create Stripe Checkout for extra session
router.post('/pay/extra-session', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) { req.session.error = 'Online payments not configured. Please pay via Zelle.'; return res.redirect('/parent/pay'); }

        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);

        if (!sub.rows[0] || !sub.rows[0].rate_total || !sub.rows[0].sessions_per_month) {
            req.session.error = 'No plan configured. Contact us first.';
            return res.redirect('/parent/pay');
        }

        const perSession = parseFloat(sub.rows[0].rate_total) / sub.rows[0].sessions_per_month;
        const extraRate = perSession + 5; // $5 inconvenience fee
        const amount = Math.round(extraRate * 100); // cents
        const serviceFee = Math.round(amount * 0.03); // 3% service fee
        const total = amount + serviceFee;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Extra Tutoring Session',
                        description: 'Per-session rate ($' + perSession.toFixed(2) + ') + $5.00 convenience fee + 3% processing fee',
                    },
                    unit_amount: total,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: (process.env.SITE_URL || 'http://localhost:3000') + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: (process.env.SITE_URL || 'http://localhost:3000') + '/payment/pay',
            metadata: {
                user_id: String(userId),
                payment_type: 'extra_session',
                extra_rate: String(extraRate.toFixed(2)),
            },
        });

        res.redirect(303, session.url);
    } catch (err) {
        console.error('Stripe error:', err.message);
        req.session.error = 'Payment failed: ' + err.message;
        res.redirect('/parent/pay');
    }
});

// Payment success page
router.get('/success', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        if (stripe && req.query.session_id) {
            const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
            if (session.payment_status === 'paid') {
                const userId = session.metadata.user_id;
                const paymentType = session.metadata.payment_type;

                // Mark as paid
                await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [userId]);

                // Log it
                try {
                    await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)',
                        [parseInt(userId), 'payment_completed', paymentType + ' payment: $' + (session.amount_total / 100).toFixed(2)]);
                } catch(e) {}

                if (paymentType === 'monthly') {
                    // Update subscription billing date
                    await pool.query(
                        "UPDATE subscriptions SET next_billing_date = CURRENT_DATE + INTERVAL '1 month', paid_through = CURRENT_DATE + INTERVAL '1 month' WHERE parent_id = $1 AND status = 'active'",
                        [parseInt(userId)]
                    );
                }
            }
        }
        res.render('parent/payment-success', { title: 'Payment Successful', meta: {} });
    } catch (err) {
        console.error(err);
        res.render('parent/payment-success', { title: 'Payment Successful', meta: {} });
    }
});

// Stripe webhook (no auth, no CSRF - Stripe sends this directly)
router.post('/webhook', async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) return res.status(200).send('OK');

        const sig = req.headers['stripe-signature'];
        let event;

        if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
            try {
                event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
            } catch (err) {
                console.error('Webhook signature verification failed:', err.message);
                return res.status(400).send('Webhook Error');
            }
        } else {
            event = req.body;
        }

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            if (session.payment_status === 'paid' && session.metadata && session.metadata.user_id) {
                await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [parseInt(session.metadata.user_id)]);
                console.log('Webhook: payment confirmed for user', session.metadata.user_id);
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(200).send('OK'); // Always return 200 to Stripe
    }
});

module.exports = router;
