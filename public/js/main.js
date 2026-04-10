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
    var token = getCsrfToken();
    var headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': token
    };
    // Inject _csrf into JSON body as fallback
    if (options.body) {
        try {
            var parsed = JSON.parse(options.body);
            parsed._csrf = token;
            options.body = JSON.stringify(parsed);
        } catch(e) {}
    } else {
        options.body = JSON.stringify({ _csrf: token });
    }
    return fetch(url, { method: options.method || 'GET', headers: headers, body: options.body });
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
        <div style="margin-top:20px;display:flex;gap:12px;"><a href="/parent/book/${tutor.id}" class="btn btn-primary btn-sm">Book Session</a><a href="/consultation" class="btn btn-outline btn-sm">Free Consultation</a></div>
    </div>`;
}

function formatTime(timeStr) {
    if (!timeStr) return '';
    var parts = timeStr.split(':');
    var hour = parseInt(parts[0], 10);
    var min = parts[1] || '00';
    var ampm = hour >= 12 ? 'PM' : 'AM';
    var hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    return hour12 + ':' + min + ' ' + ampm;
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
        const raw = editor.getAttribute('data-existing');
        if (raw && raw !== '[]' && raw !== '') {
            const parsed = JSON.parse(raw);
            for (let x = 0; x < parsed.length; x++) {
                parsed[x].day_of_week = Number(parsed[x].day_of_week);
            }
            slots = parsed;
        }
    } catch(e) {
        console.error('Availability parse error:', e);
        slots = [];
    }

    function render() {
        let html = '';
        for (let i = 0; i < days.length; i++) {
            const daySlots = [];
            for (let j = 0; j < slots.length; j++) {
                if (Number(slots[j].day_of_week) === i) daySlots.push({ idx: j, slot: slots[j] });
            }

            html += '<div style="margin-bottom:16px;padding:12px;background:var(--gray-50);border-radius:8px;">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
            html += '<span style="font-weight:700;color:var(--gray-700);">' + days[i] + '</span>';
            if (daySlots.length > 0) html += '<span style="font-size:0.75rem;color:var(--green-600);font-weight:600;">' + daySlots.length + ' slot(s)</span>';
            html += '</div>';

            for (let k = 0; k < daySlots.length; k++) {
                const s = daySlots[k].slot;
                html += '<span style="display:inline-flex;align-items:center;gap:6px;background:var(--blue-100);color:var(--blue-700);padding:4px 10px;border-radius:20px;font-size:0.85rem;font-weight:600;margin:0 6px 6px 0;">';
                html += formatTime(s.start_time) + ' - ' + formatTime(s.end_time);
                html += ' <a href="#" class="avail-remove" data-idx="' + daySlots[k].idx + '" style="color:var(--red-500);font-weight:700;font-size:1.1rem;text-decoration:none;padding:0 2px;line-height:1;">&times;</a>';
                html += '</span>';
            }

            html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">';
            html += '<input type="time" class="avail-start" data-day="' + i + '" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-family:inherit;font-size:0.9rem;background:white;">';
            html += '<span style="color:var(--gray-400);">to</span>';
            html += '<input type="time" class="avail-end" data-day="' + i + '" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-family:inherit;font-size:0.9rem;background:white;">';
            html += ' <a href="#" class="avail-add" data-day="' + i + '" style="display:inline-block;padding:6px 14px;background:var(--blue-500);color:white;border-radius:8px;font-weight:600;font-size:0.85rem;text-decoration:none;">+ Add</a>';
            html += '</div>';
            html += '</div>';
        }
        editor.innerHTML = html;
    }

    // Single event listener on the parent - handles all clicks via delegation
    editor.addEventListener('click', function(e) {
        const target = e.target;

        if (target.classList.contains('avail-add')) {
            e.preventDefault();
            const dayIdx = Number(target.getAttribute('data-day'));
            const startInput = editor.querySelector('.avail-start[data-day="' + dayIdx + '"]');
            const endInput = editor.querySelector('.avail-end[data-day="' + dayIdx + '"]');
            if (!startInput || !endInput) { alert('Error: time inputs not found'); return; }
            if (!startInput.value || !endInput.value) { alert('Please pick both a start and end time.'); return; }
            if (startInput.value >= endInput.value) { alert('End time must be after start time.'); return; }
            slots.push({ day_of_week: dayIdx, start_time: startInput.value, end_time: endInput.value });
            render();
            return;
        }

        if (target.classList.contains('avail-remove')) {
            e.preventDefault();
            const removeIdx = Number(target.getAttribute('data-idx'));
            slots.splice(removeIdx, 1);
            render();
            return;
        }
    });

    window.saveAvailability = async function() {
        try {
            var token = getCsrfToken();
            console.log('Saving', slots.length, 'slots, CSRF token length:', token.length);
            var resp = await fetch('/admin/tutor/availability', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-CSRF-Token': token
                },
                body: JSON.stringify({ slots: slots, _csrf: token })
            });
            console.log('Save response status:', resp.status);
            if (!resp.ok) {
                var errorText = await resp.text();
                console.error('Save error:', errorText);
                alert('Failed to save (status ' + resp.status + '). Check browser console.');
                return;
            }
            var data = await resp.json();
            if (data.success) {
                alert('Availability saved!');
            } else {
                alert('Failed to save: ' + (data.message || 'Unknown error'));
            }
        } catch (err) {
            console.error('Save error:', err);
            alert('Failed to save. Check browser console (F12).');
        }
    };

    render();
    console.log('Availability editor ready:', slots.length, 'existing slots');
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
