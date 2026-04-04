// ===== BrightMinds Tutoring - Client JS =====

document.addEventListener('DOMContentLoaded', () => {
    initNav();
    initTutorCards();
    initCalendar();
    initCarousel();
    initReferralCode();
    initFormValidation();
    initAlertDismiss();
    initAvailabilityEditor();
    initMessagePolling();
    initCancelSubscription();
});

// ===== NAVIGATION =====
function initNav() {
    const hamburger = document.querySelector('.nav-hamburger');
    const navLinks = document.querySelector('.nav-links');
    if (!hamburger || !navLinks) return;

    hamburger.addEventListener('click', () => {
        navLinks.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', navLinks.classList.contains('open'));
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav')) {
            navLinks.classList.remove('open');
        }
    });

    // Close on ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') navLinks.classList.remove('open');
    });
}

// ===== TUTOR CARD EXPANSION =====
function initTutorCards() {
    document.querySelectorAll('.tutor-card').forEach(card => {
        const front = card.querySelector('.tutor-card-front');
        if (!front) return;

        front.addEventListener('click', async () => {
            const wasExpanded = card.classList.contains('expanded');

            // Collapse all others
            document.querySelectorAll('.tutor-card.expanded').forEach(c => c.classList.remove('expanded'));

            if (!wasExpanded) {
                card.classList.add('expanded');
                const expandArea = card.querySelector('.tutor-card-expand');

                // Load details if not loaded
                if (expandArea && !expandArea.dataset.loaded) {
                    const tutorId = card.dataset.tutorId;
                    try {
                        const resp = await fetch(`/tutors/${tutorId}/details`);
                        const data = await resp.json();
                        if (data.tutor) {
                            expandArea.dataset.loaded = 'true';
                            renderTutorDetails(expandArea, data);
                        }
                    } catch (err) {
                        console.error('Failed to load tutor details:', err);
                    }
                }
            }
        });

        // Keyboard accessibility
        front.setAttribute('tabindex', '0');
        front.setAttribute('role', 'button');
        front.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                front.click();
            }
        });
    });
}

function renderTutorDetails(container, data) {
    const { tutor, availability } = data;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let availHtml = '';
    if (availability && availability.length > 0) {
        availHtml = availability.map(a =>
            `<div class="tutor-availability-slot">${days[a.day_of_week]}: ${formatTime(a.start_time)} - ${formatTime(a.end_time)}</div>`
        ).join('');
    } else {
        availHtml = '<p style="color:var(--gray-400);">Contact tutor for availability.</p>';
    }

    container.innerHTML = `
        <div style="padding-top:16px;">
            <p style="color:var(--gray-600);line-height:1.7;margin-bottom:16px;">${tutor.bio || 'No bio available.'}</p>
            <div class="tutor-detail-grid">
                <div class="tutor-detail-item">
                    <label>Education</label>
                    <span>${tutor.education || 'N/A'}</span>
                </div>
                <div class="tutor-detail-item">
                    <label>Experience</label>
                    <span>${tutor.experience_years || 0} years</span>
                </div>
            </div>
            <div style="margin-top:20px;">
                <label style="font-size:0.8rem;color:var(--gray-400);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px;">Available Hours</label>
                ${availHtml}
            </div>
            <div style="margin-top:20px;display:flex;gap:12px;">
                <a href="/consultation" class="btn btn-primary btn-sm">Book Consultation</a>
                <a href="/contact" class="btn btn-outline btn-sm">Contact</a>
            </div>
        </div>
    `;
}

function formatTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

// ===== CALENDAR =====
function initCalendar() {
    const calEl = document.getElementById('calendar');
    if (!calEl) return;

    const state = {
        year: new Date().getFullYear(),
        month: new Date().getMonth(),
        events: []
    };

    const prevBtn = document.getElementById('cal-prev');
    const nextBtn = document.getElementById('cal-next');
    const titleEl = document.getElementById('cal-title');

    if (prevBtn) prevBtn.addEventListener('click', () => { state.month--; if (state.month < 0) { state.month = 11; state.year--; } loadCalendar(state, calEl, titleEl); });
    if (nextBtn) nextBtn.addEventListener('click', () => { state.month++; if (state.month > 11) { state.month = 0; state.year++; } loadCalendar(state, calEl, titleEl); });

    loadCalendar(state, calEl, titleEl);
}

async function loadCalendar(state, calEl, titleEl) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (titleEl) titleEl.textContent = `${months[state.month]} ${state.year}`;

    try {
        const resp = await fetch(`/api/calendar/events?month=${state.month + 1}&year=${state.year}`);
        state.events = await resp.json();
    } catch (err) {
        state.events = [];
    }

    renderCalendar(state, calEl);
}

function renderCalendar(state, calEl) {
    const grid = calEl.querySelector('.calendar-grid');
    if (!grid) return;

    const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = dayHeaders.map(d => `<div class="calendar-day-header">${d}</div>`).join('');

    const firstDay = new Date(state.year, state.month, 1).getDay();
    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
    const daysInPrevMonth = new Date(state.year, state.month, 0).getDate();
    const today = new Date();

    // Previous month days
    for (let i = firstDay - 1; i >= 0; i--) {
        html += `<div class="calendar-day other-month"><span class="day-number">${daysInPrevMonth - i}</span></div>`;
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${state.year}-${String(state.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isToday = today.getFullYear() === state.year && today.getMonth() === state.month && today.getDate() === day;
        const dayEvents = (state.events || []).filter(e => {
            const eDate = new Date(e.booking_date);
            return eDate.getDate() === day;
        });

        html += `<div class="calendar-day${isToday ? ' today' : ''}">`;
        html += `<span class="day-number">${day}</span>`;

        dayEvents.forEach(e => {
            const label = e.tutor_first ? `${e.tutor_first} ${e.tutor_last?.charAt(0)}.` : `${e.student_first} ${e.student_last?.charAt(0)}.`;
            html += `<div class="calendar-event ${e.status}" title="${e.subject || ''} - ${label} at ${formatTime(e.start_time)}">${formatTime(e.start_time)} ${label}</div>`;
        });

        html += '</div>';
    }

    // Next month days
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
        html += `<div class="calendar-day other-month"><span class="day-number">${i}</span></div>`;
    }

    grid.innerHTML = html;
}

// ===== CAROUSEL =====
function initCarousel() {
    const track = document.querySelector('.carousel-track');
    if (!track) return;

    // Duplicate content for infinite scroll
    const items = track.innerHTML;
    track.innerHTML = items + items;
}

// ===== REFERRAL CODE =====
function initReferralCode() {
    const referralForm = document.getElementById('referral-form');
    if (!referralForm) return;

    referralForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('referral-code').value.trim();
        const resultEl = document.getElementById('referral-result');
        if (!code) return;

        try {
            const resp = await fetch('/checkout/apply-referral', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ referral_code: code })
            });
            const data = await resp.json();

            if (data.success) {
                resultEl.className = 'alert alert-success';
                resultEl.textContent = data.message;
                // Update price display
                const priceEl = document.getElementById('final-price');
                const originalEl = document.getElementById('original-price');
                if (priceEl && originalEl) {
                    const original = parseFloat(originalEl.dataset.price);
                    const discounted = original * (1 - data.discount / 100);
                    priceEl.textContent = `$${discounted.toFixed(2)}`;
                    originalEl.style.textDecoration = 'line-through';
                }
            } else {
                resultEl.className = 'alert alert-error';
                resultEl.textContent = data.message;
            }
            resultEl.style.display = 'flex';
        } catch (err) {
            resultEl.className = 'alert alert-error';
            resultEl.textContent = 'Something went wrong. Please try again.';
            resultEl.style.display = 'flex';
        }
    });
}

// ===== FORM VALIDATION =====
function initFormValidation() {
    document.querySelectorAll('form[data-validate]').forEach(form => {
        form.addEventListener('submit', (e) => {
            const required = form.querySelectorAll('[required]');
            let valid = true;
            required.forEach(field => {
                field.classList.remove('invalid');
                if (!field.value.trim()) {
                    field.classList.add('invalid');
                    valid = false;
                }
            });

            // Password match
            const pass = form.querySelector('[name="password"]');
            const confirm = form.querySelector('[name="confirm_password"]');
            if (pass && confirm && pass.value !== confirm.value) {
                confirm.classList.add('invalid');
                valid = false;
            }

            if (!valid) {
                e.preventDefault();
                const first = form.querySelector('.invalid');
                if (first) first.focus();
            }
        });
    });
}

// ===== ALERT DISMISS =====
function initAlertDismiss() {
    document.querySelectorAll('.alert').forEach(alert => {
        setTimeout(() => {
            alert.style.opacity = '0';
            alert.style.transform = 'translateY(-10px)';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    });
}

// ===== AVAILABILITY EDITOR (Tutor) =====
function initAvailabilityEditor() {
    const editor = document.getElementById('availability-editor');
    if (!editor) return;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let slots = [];

    // Load existing
    const existingSlots = editor.dataset.existing;
    if (existingSlots) {
        try { slots = JSON.parse(existingSlots); } catch(e) {}
    }

    function render() {
        let html = '<div style="margin-bottom:16px;">';
        days.forEach((day, i) => {
            const daySlots = slots.filter(s => s.day_of_week === i);
            html += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap;">
                <span style="width:100px;font-weight:700;color:var(--gray-700);">${day}</span>`;
            daySlots.forEach((s, si) => {
                html += `<span class="subject-tag" style="background:var(--blue-100);color:var(--blue-700);">
                    ${formatTime(s.start_time)} - ${formatTime(s.end_time)}
                    <button onclick="removeSlot(${i}, ${si})" style="border:none;background:none;color:var(--red-500);cursor:pointer;font-weight:700;margin-left:4px;" aria-label="Remove slot">&times;</button>
                </span>`;
            });
            html += `<button onclick="addSlot(${i})" class="btn btn-outline btn-sm" style="padding:4px 12px;font-size:0.8rem;">+ Add</button>
            </div>`;
        });
        html += '</div>';
        editor.innerHTML = html;
    }

    window.addSlot = (dayIndex) => {
        const start = prompt('Start time (e.g., 09:00):');
        const end = prompt('End time (e.g., 10:00):');
        if (start && end) {
            slots.push({ day_of_week: dayIndex, start_time: start, end_time: end });
            render();
        }
    };

    window.removeSlot = (dayIndex, slotIndex) => {
        const daySlots = slots.filter(s => s.day_of_week === dayIndex);
        const toRemove = daySlots[slotIndex];
        slots = slots.filter(s => s !== toRemove);
        render();
    };

    window.saveAvailability = async () => {
        try {
            const resp = await fetch('/admin/tutor/availability', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slots })
            });
            const data = await resp.json();
            if (data.success) {
                alert('Availability saved!');
            } else {
                alert('Failed to save. Please try again.');
            }
        } catch (err) {
            alert('Failed to save. Please try again.');
        }
    };

    render();
}

// ===== MESSAGE POLLING =====
function initMessagePolling() {
    const badge = document.querySelector('.message-badge');
    if (!badge) return;

    setInterval(async () => {
        try {
            const resp = await fetch('/api/messages/unread');
            const data = await resp.json();
            badge.textContent = data.count;
            badge.style.display = data.count > 0 ? 'inline' : 'none';
        } catch (err) {}
    }, 30000);
}

// ===== CANCEL SUBSCRIPTION =====
function initCancelSubscription() {
    const cancelBtn = document.getElementById('cancel-subscription-btn');
    if (!cancelBtn) return;

    cancelBtn.addEventListener('click', () => {
        const modal = document.getElementById('cancel-modal');
        if (modal) modal.style.display = 'flex';
    });

    const closeModal = document.getElementById('cancel-modal-close');
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            document.getElementById('cancel-modal').style.display = 'none';
        });
    }
}

// ===== BOOKING CANCEL =====
async function cancelBooking(bookingId) {
    if (!confirm('Are you sure you want to cancel this booking?')) return;
    const reason = prompt('Reason for cancellation (optional):') || '';

    try {
        const resp = await fetch(`/api/bookings/${bookingId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await resp.json();
        alert(data.message);
        if (data.success) location.reload();
    } catch (err) {
        alert('Failed to cancel booking.');
    }
}

// ===== CONFIRM BOOKING (Tutor) =====
async function confirmBooking(bookingId) {
    try {
        const resp = await fetch(`/api/bookings/${bookingId}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (data.success) location.reload();
    } catch (err) {
        alert('Failed to confirm booking.');
    }
}

// ===== FILTER TUTORS =====
function filterTutors(subject) {
    const params = new URLSearchParams(window.location.search);
    if (subject) {
        params.set('subject', subject);
    } else {
        params.delete('subject');
    }
    window.location.search = params.toString();
}

// ===== COPY REFERRAL CODE =====
function copyReferralCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        const btn = event.target;
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
    });
}
