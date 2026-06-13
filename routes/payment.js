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
        console.log('=== STRIPE PAY MONTHLY ===');
        console.log('User:', req.session.user.id, 'CSRF body:', !!req.body._csrf);
        
        const stripe = getStripe();
        if (!stripe) {
            console.log('Stripe not configured - no STRIPE_SECRET_KEY');
            req.session.error = 'Online payments are not configured yet. Please pay via Zelle.';
            return res.redirect('/payment/pay');
        }

        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);
        console.log('Subscription found:', sub.rows.length > 0, 'rate_total:', sub.rows[0] ? sub.rows[0].rate_total : 'none');
        
        if (!sub.rows[0] || !sub.rows[0].rate_total) {
            req.session.error = 'No active plan found. Contact us to set up your plan.';
            return res.redirect('/payment/pay');
        }

        const amount = Math.round(parseFloat(sub.rows[0].rate_total) * 100);
        const serviceFee = Math.ceil((amount + 30) / 0.971) - amount;
        const total = amount + serviceFee;
        console.log('Amount cents:', amount, 'Fee:', serviceFee, 'Total:', total);

        const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
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
            success_url: siteUrl + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: siteUrl + '/payment/pay',
            metadata: {
                user_id: String(userId),
                payment_type: 'monthly',
                plan_name: sub.rows[0].plan_name,
            },
        });

        console.log('Stripe session created:', session.id, 'URL:', session.url);
        return res.redirect(session.url);
    } catch (err) {
        console.error('Stripe error:', err.message);
        req.session.error = 'Payment failed: ' + err.message;
        res.redirect('/payment/pay');
    }
});

// Create Stripe Checkout for extra session
router.post('/pay/extra-session', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) { req.session.error = 'Online payments not configured. Please pay via Zelle.'; return res.redirect('/payment/pay'); }

        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);

        if (!sub.rows[0] || !sub.rows[0].rate_total || !sub.rows[0].sessions_per_month) {
            req.session.error = 'No plan configured. Contact us first.';
            return res.redirect('/payment/pay');
        }

        const perSession = parseFloat(sub.rows[0].rate_total) / sub.rows[0].sessions_per_month;
        const extraRate = sub.rows[0].extra_session_rate ? parseFloat(sub.rows[0].extra_session_rate) : (perSession + 5);
        const amount = Math.round(extraRate * 100); // cents
        const serviceFee = Math.ceil((amount + 30) / 0.971) - amount; // 2.9% + 30¢
        const total = amount + serviceFee;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Extra Tutoring Session',
                        description: 'Extra session rate: $' + extraRate.toFixed(2) + ' + 2.9% + 30c processing fee',
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

        return res.redirect(session.url);
    } catch (err) {
        console.error('Stripe error:', err.message);
        req.session.error = 'Payment failed: ' + err.message;
        res.redirect('/payment/pay');
    }
});

// Payment success page
router.get('/success', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        const userId = req.session.user.id;

        if (stripe && req.query.session_id) {
            const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
            const metaUserId = parseInt(session.metadata?.user_id) || userId;
            const paymentType = session.metadata?.payment_type || 'monthly';

            // Always mark as paid - they completed checkout
            await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [metaUserId]);

            if (paymentType === 'monthly') {
                try { await pool.query("UPDATE subscriptions SET next_billing_date = CURRENT_DATE + INTERVAL '1 month', paid_through = CURRENT_DATE + INTERVAL '1 month' WHERE parent_id = $1 AND status = 'active'", [metaUserId]); } catch(e) {}
            } else if (paymentType === 'extra_session') {
                try { await pool.query("UPDATE subscriptions SET extra_session_credits = COALESCE(extra_session_credits, 0) + 1 WHERE parent_id = $1 AND status = 'active'", [metaUserId]); } catch(e) {}
            }

            try { await pool.query('INSERT INTO audit_log (user_id, action, details) VALUES ($1, $2, $3)', [metaUserId, 'payment_completed', paymentType + ' $' + ((session.amount_total || 0) / 100).toFixed(2)]); } catch(e) {}
        } else {
            // Fallback - no Stripe session but they landed here, mark paid
            await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [userId]);
        }
    } catch (err) {
        console.error('Payment success error:', err.message);
        try { await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [req.session.user.id]); } catch(e) {}
    }
    res.render('parent/payment-success', { title: 'Payment Successful', meta: {} });
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
                const uid = parseInt(session.metadata.user_id);
                await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [uid]);
                if (session.metadata.payment_type === 'extra_session') {
                    await pool.query("UPDATE subscriptions SET extra_session_credits = COALESCE(extra_session_credits, 0) + 1 WHERE parent_id = $1 AND status = 'active'", [uid]);
                }
                if (session.metadata.payment_type === 'monthly') {
                    await pool.query("UPDATE subscriptions SET next_billing_date = CURRENT_DATE + INTERVAL '1 month', paid_through = CURRENT_DATE + INTERVAL '1 month' WHERE parent_id = $1 AND status = 'active'", [uid]);
                }
                if (session.metadata.payment_type === 'subscription' && session.subscription) {
                    await pool.query("UPDATE subscriptions SET stripe_subscription_id = $1 WHERE parent_id = $2 AND status = 'active'", [session.subscription, uid]);
                }
                console.log('Webhook: payment confirmed for user', uid, 'type:', session.metadata.payment_type);
            }
        }

        // Handle recurring subscription payments
        if (event.type === 'invoice.paid') {
            const invoice = event.data.object;
            if (invoice.customer) {
                const user = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [invoice.customer]);
                if (user.rows[0]) {
                    await pool.query("UPDATE users SET payment_status = 'paid' WHERE id = $1", [user.rows[0].id]);
                    await pool.query("UPDATE subscriptions SET next_billing_date = CURRENT_DATE + INTERVAL '1 month', paid_through = CURRENT_DATE + INTERVAL '1 month' WHERE parent_id = $1 AND status = 'active'", [user.rows[0].id]);
                    console.log('Webhook: subscription payment for user', user.rows[0].id);
                }
            }
        }
        if (event.type === 'invoice.payment_failed') {
            const invoice = event.data.object;
            if (invoice.customer) {
                const user = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [invoice.customer]);
                if (user.rows[0]) {
                    await pool.query("UPDATE users SET payment_status = 'unpaid' WHERE id = $1", [user.rows[0].id]);
                    console.log('Webhook: payment failed for user', user.rows[0].id);
                }
            }
        }

        // Handle subscription cancellation (from Stripe dashboard or auto-cancel)
        if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            if (subscription.customer) {
                const user = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [subscription.customer]);
                if (user.rows[0]) {
                    await pool.query("UPDATE users SET payment_status = 'unpaid' WHERE id = $1", [user.rows[0].id]);
                    await pool.query("UPDATE subscriptions SET stripe_subscription_id = NULL WHERE parent_id = $1 AND stripe_subscription_id = $2", [user.rows[0].id, subscription.id]);
                    console.log('Webhook: subscription cancelled for user', user.rows[0].id);
                }
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(200).send('OK'); // Always return 200 to Stripe
    }
});

// Create Stripe recurring subscription
router.post('/pay/subscribe', isAuthenticated, async (req, res) => {
    try {
        const stripe = getStripe();
        if (!stripe) { req.session.error = 'Online payments not configured.'; return res.redirect('/payment/pay'); }

        const userId = req.session.user.id;
        const sub = await pool.query("SELECT * FROM subscriptions WHERE parent_id = $1 AND status = 'active'", [userId]);
        if (!sub.rows[0] || !sub.rows[0].rate_total) {
            req.session.error = 'No active plan found.';
            return res.redirect('/payment/pay');
        }

        const amount = Math.round(parseFloat(sub.rows[0].rate_total) * 100);
        const siteUrl = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');

        // Create or reuse Stripe customer
        const userRow = await pool.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [userId]);
        let customerId = userRow.rows[0].stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({ email: userRow.rows[0].email, metadata: { user_id: String(userId) } });
            customerId = customer.id;
            await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, userId]);
        }

        // Create subscription checkout
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: sub.rows[0].plan_name + ' - Monthly Subscription' },
                    unit_amount: amount,
                    recurring: { interval: 'month' },
                },
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: siteUrl + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: siteUrl + '/payment/pay',
            metadata: { user_id: String(userId), payment_type: 'subscription' },
        });

        return res.redirect(session.url);
    } catch (err) {
        console.error('Stripe subscription error:', err.message);
        req.session.error = 'Payment setup failed: ' + err.message;
        res.redirect('/payment/pay');
    }
});

module.exports = router;
