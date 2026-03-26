import { supabase } from './supabase.js';

// ========================
// Redirect if not logged in
// ========================
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.href = '../pages/login_signup.html';
}

const user = session.user;

// ========================
// Load Reservations
// ========================
async function loadReservations() {
    const list = document.getElementById('reservations-list');
    list.innerHTML = '<p style="color:#aaa;text-align:center;padding:40px 0;">Loading…</p>';

    const { data: reservations, error } = await supabase
        .from('reservations')
        .select(`
            *,
            package:package_id ( package_name, package_type ),
            add_on:add_on_id   ( package_name, package_type )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        list.innerHTML = '<p style="color:#c0392b;text-align:center;padding:40px 0;">Failed to load reservations.</p>';
        return;
    }

    if (!reservations || reservations.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <h3>No reservations yet</h3>
                <p>You haven't made any bookings yet. When you do, they'll appear here.</p>
                <a href="../pages/reservations.html" class="res-book-btn">Book an Event</a>
            </div>`;
        return;
    }

    list.innerHTML = '';
    reservations.forEach(r => {
        const statusLabel = {
            pending:   '⏳ Pending Verification',
            confirmed: '✅ Confirmed',
            cancelled: '❌ Cancelled'
        }[r.status] || r.status;

        const date = r.event_date
            ? new Date(r.event_date).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
            : '—';

        const price = r.total_price > 0
            ? '₱' + Number(r.total_price).toLocaleString()
            : 'Contact for quote';

        const location = r.location_type === 'onsite'
            ? '🏠 Onsite — ELI Coffee'
            : `🚗 Offsite — ${r.venue_location || ''}`;

        const submittedOn = new Date(r.created_at).toLocaleDateString('en-PH', {
            year: 'numeric', month: 'short', day: 'numeric'
        });

        const packageName = r.package?.package_name || r.package_id || '—';
        const addOnName   = r.add_on?.package_name  || null;

        const card = document.createElement('div');
        card.className = 'reservation-card';
        card.innerHTML = `
            <div class="res-card-header">
                <div>
                    <h4>${r.event_type || 'Event'}</h4>
                    <p class="res-submitted">Submitted on ${submittedOn}</p>
                </div>
                <span class="res-status ${r.status}">${statusLabel}</span>
            </div>
            <div class="res-card-body">
                <div class="res-detail"><span class="res-icon">📅</span><span><strong>Date:</strong> ${date}</span></div>
                <div class="res-detail"><span class="res-icon">🕐</span><span><strong>Time:</strong> ${r.event_time || '—'}</span></div>
                <div class="res-detail"><span class="res-icon">👥</span><span><strong>Guests:</strong> ${r.guest_count || '—'}</span></div>
                <div class="res-detail"><span class="res-icon">📍</span><span><strong>Location:</strong> ${location}</span></div>
                <div class="res-detail"><span class="res-icon">🎁</span><span><strong>Package:</strong> ${packageName}</span></div>
                ${addOnName ? `<div class="res-detail"><span class="res-icon">🍫</span><span><strong>Add-on:</strong> ${addOnName}</span></div>` : ''}
                <div class="res-detail"><span class="res-icon">💰</span><span><strong>Total:</strong> ${price}</span></div>
                ${r.special_requests ? `<div class="res-detail"><span class="res-icon">📝</span><span><strong>Notes:</strong> ${r.special_requests}</span></div>` : ''}
            </div>
        `;
        list.appendChild(card);
    });
}

// ========================
// Load Profile Data
// ========================
const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

if (profile) {
    // Sidebar
    document.getElementById('sidebar-name').innerText = `${profile.first_name} ${profile.last_name}`;
    document.getElementById('sidebar-email').innerText = profile.email;

    // Profile form
    document.getElementById('profile-first-name').value  = profile.first_name || '';
    document.getElementById('profile-middle-name').value = profile.middle_name || '';
    document.getElementById('profile-last-name').value   = profile.last_name || '';
    document.getElementById('profile-email').value       = profile.email || '';
    document.getElementById('profile-phone').value       = profile.phone_number || '';

    // Format date registered
    const date = new Date(profile.date_registered);
    document.getElementById('profile-date').value = date.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

// ========================
// Sidebar Navigation
// ========================
const navItems = document.querySelectorAll('.account-nav-item[data-section]');
const sections = document.querySelectorAll('.account-section');

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const target = item.dataset.section;

        // Update active nav item
        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Show target section
        sections.forEach(s => s.classList.remove('active'));
        document.getElementById(`section-${target}`).classList.add('active');

        // Load reservations when tab is clicked
        if (target === 'reservations') {
            loadReservations();
        }
    });
});

// Pre-load reservations in background
loadReservations();

// ========================
// Logout
// ========================
document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '../pages/login_signup.html';
});

// ========================
// Save Profile Changes
// ========================
document.getElementById('profile-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const msg = document.getElementById('profile-msg');

    const { error } = await supabase
        .from('profiles')
        .update({
            first_name:   document.getElementById('profile-first-name').value.trim(),
            middle_name:  document.getElementById('profile-middle-name').value.trim() || null,
            last_name:    document.getElementById('profile-last-name').value.trim(),
            phone_number: document.getElementById('profile-phone').value.trim(),
        })
        .eq('id', user.id);

    if (error) {
        msg.className = 'form-msg error';
        msg.innerText = 'Failed to save changes: ' + error.message;
    } else {
        msg.className = 'form-msg success';
        msg.innerText = '✅ Profile updated successfully!';

        // Update sidebar name
        document.getElementById('sidebar-name').innerText =
            `${document.getElementById('profile-first-name').value} ${document.getElementById('profile-last-name').value}`;
    }
});

// ========================
// Change Password
// ========================
document.getElementById('password-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const msg = document.getElementById('password-msg');

    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-new-password').value;

    msg.className = 'form-msg';
    msg.innerText = '';

    if (!currentPassword || !newPassword || !confirmPassword) {
        msg.className = 'form-msg error';
        msg.innerText = 'Please fill in all password fields.';
        return;
    }

    if (newPassword !== confirmPassword) {
        msg.className = 'form-msg error';
        msg.innerText = 'Passwords do not match.';
        return;
    }

    if (newPassword.length < 8) {
        msg.className = 'form-msg error';
        msg.innerText = 'Password must be at least 8 characters.';
        return;
    }

    if (currentPassword === newPassword) {
        msg.className = 'form-msg error';
        msg.innerText = 'New password must be different from current password.';
        return;
    }

    const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();

    if (userError || !currentUser?.email) {
        msg.className = 'form-msg error';
        msg.innerText = 'Unable to verify your account. Please log in again.';
        return;
    }

    const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPassword
    });

    if (reauthError) {
        msg.className = 'form-msg error';
        msg.innerText = 'Current password is incorrect.';
        return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
        msg.className = 'form-msg error';
        msg.innerText = 'Failed to update password: ' + error.message;
    } else {
        msg.className = 'form-msg success';
        msg.innerText = '✅ Password updated successfully!';
        document.getElementById('password-form').reset();
    }
});
