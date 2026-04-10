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

// CSRF token helper - reads from meta tag
function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
}

// Secure fetch wrapper that includes CSRF token
function secureFetch(url, options = {}) {
    const defaults = { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() } };
    return fetch(url, { ...defaults, ...options, headers: { ...defaults.headers, ...(options.headers || {}) } });
}

function initNav() {
    const hamburger = document.querySelector('.nav-hamburger');
    const navLinks = document.querySelector('.nav-links');
    if (!hamburger || !navLinks) return;
    hamburger.addEventListener('click', () => {
        navLinks.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', navLinks.classList.contains('open'));
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) navLinks.classList.remove('open'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') navLinks.classList.remove('open'); });
}

function initTutorCards() {
    document.querySelectorAll('.tutor-card').forEach(card => {
        const front = card.querySelector('.tutor-card-front');
        if (!front) return;
        front.addEventListener('click', async () => {
            const wasExpanded = card.classList.contains('expanded');
            document.querySelectorAll('.tutor-card.expanded').forEach(c => c.classList.remove('expanded'));
            if (!wasExpanded) {
                card.classList.add('expanded');
                const expandArea = card.querySelector('.tutor-card-expand');
                if (expandArea && !expandArea.dataset.loaded) {
                    try {
                        const resp = await fetch(`/tutors/${card.dataset.tutorId}/details`);
                        const data = await resp.json();
                        if (data.tutor) { expandArea.dataset.loaded = 'true'; renderTutorDetails(expandArea, data); }
                    } catch (err) { console.error(err); }
                }
            }
        });
        front.setAttribute('tabindex', '0');
        front.setAttribute('role', 'button');
        front.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); front.click(); } });
    });
}

function renderTutorDetails(container, data) {
    const { tutor, availability } = data;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let availHtml = availability && availability.length > 0
        ? availability.map(a => `<div style="padding:4px 0;">${days[a.day_of_week]}: ${formatTime(a.start_time)} - ${formatTime(a.end_time)}</div>`).join('')
        : '<p style="color:var(--gray-400);">Contact tutor for availability.</p>';
    container.innerHTML = `<div style="padding-top:16px;">
        <p style="color:var(--gray-600);line-height:1.7;margin-bottom:16px;">${tutor.bio || 'No bio available.'}</p>
        <div class="tutor-detail-grid"><div class="tutor-detail-item"><label>Education</label><span>${tutor.education || 'N/A'}</span></div><div class="tutor-detail-item"><label>Experience</label><span>${tutor.experience_years || 0} years</span></div></div>
        <div style="margin-top:20px;"><label style="font-size:0.8rem;color:var(--gray-400);font-weight:700;text-transform:uppercase;display:block;margin-bottom:8px;">Available Hours</label>${availHtml}</div>
        <div style="margin-top:20px;display:flex;gap:12px;"><a href="/consultation" class="btn btn-primary btn-sm">Book Consultation</a><a href="/contact" class="btn btn-outline btn-sm">Contact</a></div>
    </div>`;
}

function formatTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m || '00'} ${hour >= 12 ? 'PM' : 'AM'}`;
}

// ===== CALENDAR =====
function initCalendar() {
    const calEl = document.getElementById('calendar');
    if (!calEl) return;
    const state = { year: new Date().getFullYear(), month: new Date().getMonth(), events: [] };
    const prevBtn = document.getElementById('cal-prev');
    const nextBtn = document.getElementById('cal-next');
    const titleEl = document.getElementById('cal-title');
    if (prevBtn) prevBtn.addEventListener('click', () => { state.month--; if (state.month < 0) { state.month = 11; state.year--; } loadCalendar(state, calEl, titleEl); });
    if (nextBtn) nextBtn.addEventListener('click', () => { state.month++; if (state.month > 11) { state.month = 0; state.year++; } loadCalendar(state, calEl, titleEl); });
    loadCalendar(state, calEl, titleEl);
}

async function loadCalendar(state, calEl, titleEl) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (titleEl) titleEl.textContent = `${months[state.month]} ${state.year}`;
    try { const resp = await fetch(`/api/calendar/events?month=${state.month + 1}&year=${state.year}`); state.events = await resp.json(); } catch (err) { state.events = []; }
    renderCalendar(state, calEl);
}

function renderCalendar(state, calEl) {
    const grid = calEl.querySelector('.calendar-grid');
    if (!grid) return;
    const dayHeaders = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let html = dayHeaders.map(d => `<div class="calendar-day-header">${d}</div>`).join('');
    const firstDay = new Date(state.year, state.month, 1).getDay();
    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
    const daysInPrevMonth = new Date(state.year, state.month, 0).getDate();
    const today = new Date();
    for (let i = firstDay - 1; i >= 0; i--) html += `<div class="calendar-day other-month"><span class="day-number">${daysInPrevMonth - i}</span></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const isToday = today.getFullYear() === state.year && today.getMonth() === state.month && today.getDate() === day;
        const dayEvents = (state.events || []).filter(e => new Date(e.booking_date).getDate() === day);
        html += `<div class="calendar-day${isToday ? ' today' : ''}"><span class="day-number">${day}</span>`;
        dayEvents.forEach(e => {
            const label = e.tutor_first ? `${e.tutor_first} ${e.tutor_last?.charAt(0)}.` : `${e.student_first} ${e.student_last?.charAt(0)}.`;
            html += `<div class="calendar-event ${e.status}" title="${e.subject || ''} - ${label}">${formatTime(e.start_time)} ${label}</div>`;
        });
        html += '</div>';
    }
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) html += `<div class="calendar-day other-month"><span class="day-number">${i}</span></div>`;
    grid.innerHTML = html;
}

function initCarousel() {
    const track = document.querySelector('.carousel-track');
    if (!track) return;
    track.innerHTML = track.innerHTML + track.innerHTML;
}

function initReferralCode() {
    const referralForm = document.getElementById('referral-form');
    if (!referralForm) return;
    referralForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('referral-code').value.trim();
        const resultEl = document.getElementById('referral-result');
        if (!code) return;
        try {
            const resp = await secureFetch('/checkout/apply-referral', { method: 'POST', body: JSON.stringify({ referral_code: code }) });
            const data = await resp.json();
            resultEl.className = data.success ? 'alert alert-success' : 'alert alert-error';
            resultEl.textContent = data.message;
            resultEl.style.display = 'flex';
        } catch (err) { resultEl.className = 'alert alert-error'; resultEl.textContent = 'Something went wrong.'; resultEl.style.display = 'flex'; }
    });
}

function initFormValidation() {
    document.querySelectorAll('form[data-validate]').forEach(form => {
        form.addEventListener('submit', (e) => {
            let valid = true;
            form.querySelectorAll('[required]').forEach(f => { f.classList.remove('invalid'); if (!f.value.trim()) { f.classList.add('invalid'); valid = false; } });
            const pass = form.querySelector('[name="password"]');
            const confirm = form.querySelector('[name="confirm_password"]');
            if (pass && confirm && pass.value !== confirm.value) { confirm.classList.add('invalid'); valid = false; }
            if (!valid) { e.preventDefault(); const first = form.querySelector('.invalid'); if (first) first.focus(); }
        });
    });
}

function initAlertDismiss() {
    document.querySelectorAll('.alert').forEach(alert => {
        setTimeout(() => { alert.style.opacity = '0'; alert.style.transform = 'translateY(-10px)'; setTimeout(() => alert.remove(), 300); }, 6000);
    });
}

// ===== AVAILABILITY EDITOR =====
function initAvailabilityEditor() {
    const editor = document.getElementById('availability-editor');
    if (!editor) return;

    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    let slots = [];

    try {
        const raw = editor.dataset.existing;
        if (raw && raw !== '[]') {
            slots = JSON.parse(raw);
            // Ensure day_of_week is a number
            slots = slots.map(s => ({ ...s, day_of_week: Number(s.day_of_week) }));
        }
    } catch(e) {
        console.error('Failed to parse existing availability:', e);
        slots = [];
    }

    function render() {
        let html = '';
        days.forEach((day, i) => {
            const daySlots = slots.filter(s => Number(s.day_of_week) === i);
            html += '<div style="margin-bottom:16px;padding:12px;background:var(--gray-50);border-radius:8px;">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
            html += '<span style="font-weight:700;color:var(--gray-700);min-width:100px;">' + day + '</span>';
            if (daySlots.length > 0) {
                html += '<span style="font-size:0.75rem;color:var(--gray-400);">' + daySlots.length + ' slot' + (daySlots.length > 1 ? 's' : '') + '</span>';
            }
            html += '</div>';

            daySlots.forEach((s, si) => {
                html += '<div style="display:inline-flex;align-items:center;gap:6px;background:var(--blue-100);color:var(--blue-700);padding:4px 10px;border-radius:20px;font-size:0.85rem;font-weight:600;margin:0 6px 6px 0;">';
                html += formatTime(s.start_time) + ' - ' + formatTime(s.end_time);
                html += ' <button type="button" data-action="remove" data-day="' + i + '" data-slot="' + si + '" style="border:none;background:none;color:var(--red-500);cursor:pointer;font-weight:700;font-size:1rem;line-height:1;padding:0 2px;">&times;</button>';
                html += '</div>';
            });

            html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;">';
            html += '<input type="time" data-start="' + i + '" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-family:inherit;font-size:0.9rem;">';
            html += '<span style="color:var(--gray-400);">to</span>';
            html += '<input type="time" data-end="' + i + '" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-family:inherit;font-size:0.9rem;">';
            html += ' <button type="button" data-action="add" data-day="' + i + '" style="padding:6px 14px;background:var(--blue-500);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.85rem;">+ Add</button>';
            html += '</div>';
            html += '</div>';
        });
        editor.innerHTML = html;

        // Attach event listeners via delegation (more reliable than onclick attributes)
        editor.querySelectorAll('[data-action="add"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const dayIndex = Number(this.dataset.day);
                const startEl = editor.querySelector('[data-start="' + dayIndex + '"]');
                const endEl = editor.querySelector('[data-end="' + dayIndex + '"]');
                if (!startEl || !endEl) { alert('Error: inputs not found'); return; }
                if (!startEl.value || !endEl.value) { alert('Please select both start and end times.'); return; }
                if (startEl.value >= endEl.value) { alert('End time must be after start time.'); return; }
                slots.push({ day_of_week: dayIndex, start_time: startEl.value, end_time: endEl.value });
                render();
            });
        });

        editor.querySelectorAll('[data-action="remove"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const dayIndex = Number(this.dataset.day);
                const slotIndex = Number(this.dataset.slot);
                const daySlots = slots.filter(s => Number(s.day_of_week) === dayIndex);
                const toRemove = daySlots[slotIndex];
                if (toRemove) {
                    slots = slots.filter(s => s !== toRemove);
                    render();
                }
            });
        });
    }

    // Save button uses secureFetch
    window.saveAvailability = async () => {
        try {
            const resp = await secureFetch('/admin/tutor/availability', {
                method: 'POST',
                body: JSON.stringify({ slots })
            });
            const data = await resp.json();
            if (data.success) {
                alert('Availability saved!');
            } else {
                alert('Failed to save: ' + (data.message || 'Unknown error'));
            }
        } catch (err) {
            alert('Failed to save. Please try again.');
            console.error(err);
        }
    };

    render();
}

function initMessagePolling() {
    const badge = document.querySelector('.message-badge');
    if (!badge) return;
    setInterval(async () => { try { const resp = await fetch('/api/messages/unread'); const data = await resp.json(); badge.textContent = data.count; badge.style.display = data.count > 0 ? 'inline' : 'none'; } catch(e){} }, 30000);
}

function initCancelSubscription() {
    const cancelBtn = document.getElementById('cancel-subscription-btn');
    if (!cancelBtn) return;
    cancelBtn.addEventListener('click', () => { document.getElementById('cancel-modal').style.display = 'flex'; });
    const closeModal = document.getElementById('cancel-modal-close');
    if (closeModal) closeModal.addEventListener('click', () => { document.getElementById('cancel-modal').style.display = 'none'; });
}

async function cancelBooking(bookingId) {
    if (!confirm('Cancel this booking?')) return;
    const reason = prompt('Reason (optional):') || '';
    try {
        const resp = await secureFetch(`/api/bookings/${bookingId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
        const data = await resp.json();
        alert(data.message);
        if (data.success) location.reload();
    } catch (err) { alert('Failed.'); }
}

async function confirmBooking(bookingId) {
    try { const resp = await secureFetch(`/api/bookings/${bookingId}/confirm`, { method: 'POST' }); const data = await resp.json(); if (data.success) location.reload(); } catch (err) { alert('Failed.'); }
}

function filterTutors(subject) {
    const params = new URLSearchParams(window.location.search);
    if (subject) { params.set('subject', subject); } else { params.delete('subject'); }
    window.location.search = params.toString();
}
