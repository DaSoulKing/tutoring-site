require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function setup() {
    const client = await pool.connect();
    try {
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await client.query(schema);
        console.log('Database schema created successfully');

        // Create default owner account
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(process.env.OWNER_DEFAULT_PASSWORD || 'changeme123', 12);
        const code = 'BRIGHT' + Math.random().toString(36).substring(2, 8).toUpperCase();

        await client.query(`
            INSERT INTO users (email, password_hash, role, first_name, last_name, phone, referral_code)
            VALUES ($1, $2, 'owner', 'Admin', 'Owner', '', $3)
            ON CONFLICT (email) DO NOTHING
        `, [process.env.OWNER_EMAIL || 'admin@brightminds.com', hash, code]);

        console.log('Default owner account created');
        console.log('Setup complete!');
    } catch (err) {
        console.error('Setup error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

setup();
