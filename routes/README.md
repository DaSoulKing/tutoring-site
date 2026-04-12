# BrightMinds Tutoring Platform

A full-stack tutoring platform built with Express, EJS, PostgreSQL, and vanilla CSS/JS. Designed for deployment on Railway.

## Features

### Public Pages
- **Home** - Hero section, stats bar, auto-scrolling tutor carousel (pauses on hover), services preview, CTA
- **About Us** - Meet the founders and tutors
- **Services** - Detailed service offerings and how-it-works flow
- **Our Tutors** - Browsable tutor directory with subject filters, search, and expandable cards showing bio/availability/hours
- **Blog** - Blog listing and individual posts
- **Contact** - Contact form with inquiry types (complaint, support, feedback, etc.) and reCAPTCHA
- **Book Free Consultation** - Consultation request form
- **Employment** - Apply to be a tutor or register as a student
- **Checkout** - Pricing plans with referral code discount system (10% off)
- **Terms & Conditions** - Rules, regulations, cancellation policies, tutor responsibilities
- **Charity** - About the charity, stats, and mission (3% of every payment)

### Parent/Student Dashboard
- **Dashboard** - Upcoming sessions, active subscription, referral code (copy to clipboard), report cards
- **Calendar** - Custom-built, colorful calendar showing sessions (confirmed/pending/cancelled)
- **Messages** - In-app messaging system with conversation threads (parent-to-tutor)
- **Contact/Inquiries** - Submit complaints, questions, or feedback
- **Video Sessions** - Jitsi Meet integration (free, no signup required, runs in browser)
- **Cancel Subscription** - Self-service cancellation with reason collection

### Tutor Dashboard
- **Dashboard** - Profile editor, student list, upcoming sessions
- **Availability Editor** - Set recurring weekly availability slots
- **Session Sheets** - Fill out per-session reports (topics, performance, homework, notes)
- **Report Cards** - Create styled report cards with grades, scores, strengths, improvement areas
- **Calendar** - View personal schedule with availability and bookings
- **Messages** - Communicate with parents/students

### Owner Dashboard
- **Dashboard** - Stats overview (tutors, students, subscriptions, pending apps)
- **3-Month Check-in Alerts** - Automated alerts when student check-ins are due
- **Payment Reminders** - Upcoming billing with client contact details (also texts parents)
- **Application Management** - Review, accept, or reject tutor/student applications
- **Inquiry Management** - View and resolve open inquiries/complaints
- **Manage Tutors** - View all tutors, access notes
- **Manage Students** - View all students/parents, access notes
- **Notes System** - Add pinned/regular notes on any tutor or student (record keeping)
- **Calendar** - View all sessions across all tutors

### Technical Features
- Referral code system (unique per user, 10% discount)
- reCAPTCHA integration on all public forms
- Scheduled background tasks (check-in alerts, payment reminders)
- Group sessions support (multiple students per tutor call)
- Booking conflict detection
- Late cancellation tracking (24-hour rule)
- Session-based authentication with PostgreSQL session store
- Mobile-responsive design
- Accessibility: skip links, ARIA labels, keyboard navigation, focus styles
- Reduced motion support
- Print styles for report cards

## Tech Stack

- **Backend:** Node.js, Express.js
- **Views:** EJS templates
- **Database:** PostgreSQL
- **Styling:** Custom CSS (no framework)
- **Fonts:** Baloo 2 (display) + Nunito (body) via Google Fonts
- **Video:** Jitsi Meet (free, no signup)
- **Deployment:** Railway

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Local Development

1. Clone the repo:
```bash
git clone https://github.com/your-repo/brightminds-tutoring.git
cd brightminds-tutoring
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

4. Update `.env` with your database URL and other settings.

5. Set up the database:
```bash
npm run db:setup
```

6. Start the dev server:
```bash
npm run dev
```

7. Visit `http://localhost:3000`

### Railway Deployment

1. Push code to GitHub.

2. In Railway:
   - Create a new project
   - Add a PostgreSQL service
   - Connect your GitHub repo
   - Railway auto-detects the Procfile

3. Set environment variables in Railway:
   - `DATABASE_URL` (auto-set if using Railway PostgreSQL)
   - `SESSION_SECRET` (generate a random string)
   - `NODE_ENV=production`
   - `SITE_URL=https://your-app.railway.app`
   - `OWNER_EMAIL` and `OWNER_DEFAULT_PASSWORD`
   - `RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` (from Google)
   - `CHARITY_NAME` (your charity name)

4. Run the database setup:
   - In Railway shell: `npm run db:setup`

### reCAPTCHA Setup

1. Go to https://www.google.com/recaptcha/admin
2. Register a new site (reCAPTCHA v2 checkbox)
3. Add your domain(s)
4. Copy Site Key and Secret Key to your `.env`

## Color Scheme

- Primary Blue: `#3B82F6` (and variants)
- Accent Yellow: `#F59E0B` (and variants)
- Playful yet professional, kid-friendly design
- Rounded corners, soft shadows, friendly typography

## Content Notes

- No em dashes used anywhere in the site content
- 3% charity donation is mentioned on homepage, footer, checkout, and dedicated charity page
- Stats on homepage can be customized (currently showing sample numbers)
- Tutor carousel shows placeholder data when no tutors are in the database
