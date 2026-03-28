import { supabase } from './supabase.js';

const CONTRACT_FILES = {
    onsite_vip: '../files/contracts/contract-vip-lounge.pdf',
    onsite_main_hall: '../files/contracts/contract-main-hall.pdf',
    onsite_default: '',
    add_on_snack: '../files/contracts/contract-snack-bar.pdf',
    offsite_coffee: '../files/contracts/contract-coffee-bar.pdf',
    offsite_snack: '../files/contracts/contract-snack-bar.pdf',
    offsite_catering: '../files/contracts/contract-catering.pdf',
    default: ''
};

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.href = '../pages/login_signup.html';
}

const user = session.user;

async function loadReservations() {
    const list = document.getElementById('reservations-list');
    list.innerHTML = '<p style="color:#aaa;text-align:center;padding:40px 0;">Loading...</p>';

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

    const reservationIds = (reservations || []).map(r => r.reservation_id).filter(Boolean);
    let contractsByReservationId = {};

    if (reservationIds.length) {
        const { data: contracts, error: contractsError } = await supabase
            .from('contracts')
            .select('reservation_id, contract_url, verified_date')
            .in('reservation_id', reservationIds);

        if (contractsError) {
            console.error('Failed to load contracts:', contractsError);
        } else {
            contractsByReservationId = contracts.reduce((map, contract) => {
                map[contract.reservation_id] = contract;
                return map;
            }, {});
        }
    }

    if (!reservations || reservations.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">No reservations yet</div>
                <h3>No reservations yet</h3>
                <p>You haven't made any bookings yet. When you do, they'll appear here.</p>
                <a href="../pages/reservations.html" class="res-book-btn">Book an Event</a>
            </div>`;
        return;
    }

    list.innerHTML = '';
    reservations.forEach(r => {
        const statusLabel = {
            pending: 'Pending Verification',
            confirmed: 'Confirmed',
            cancelled: 'Cancelled'
        }[r.status] || r.status;

        const date = r.event_date
            ? new Date(r.event_date).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
            : '—';

        const price = r.total_price > 0
            ? '₱' + Number(r.total_price).toLocaleString()
            : 'Contact for quote';

        const location = r.location_type === 'onsite'
            ? 'Onsite — ELI Coffee'
            : `Offsite — ${r.venue_location || ''}`;

        const submittedOn = new Date(r.created_at).toLocaleDateString('en-PH', {
            year: 'numeric', month: 'short', day: 'numeric'
        });

        const packageName = r.package?.package_name || r.package_id || '—';
        const addOnName = r.add_on?.package_name || null;
        const packageContractUrl = getContractFileForReservation(r);
        const signedContract = contractsByReservationId[r.reservation_id];
        const verifiedLabel = signedContract?.verified_date
            ? `Verified on ${new Date(signedContract.verified_date).toLocaleDateString('en-PH', {
                year: 'numeric', month: 'short', day: 'numeric'
            })}`
            : 'Pending verification';

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
                <div class="res-detail"><span class="res-icon">Date:</span><span><strong>Date:</strong> ${date}</span></div>
                <div class="res-detail"><span class="res-icon">Time:</span><span><strong>Time:</strong> ${r.event_time || '—'}</span></div>
                <div class="res-detail"><span class="res-icon">Guests:</span><span><strong>Guests:</strong> ${r.guest_count || '—'}</span></div>
                <div class="res-detail"><span class="res-icon">Location:</span><span><strong>Location:</strong> ${location}</span></div>
                <div class="res-detail"><span class="res-icon">Package:</span><span><strong>Package:</strong> ${packageName}</span></div>
                ${addOnName ? `<div class="res-detail"><span class="res-icon">Add-on:</span><span><strong>Add-on:</strong> ${addOnName}</span></div>` : ''}
                <div class="res-detail"><span class="res-icon">Total:</span><span><strong>Total:</strong> ${price}</span></div>
                ${r.special_requests ? `<div class="res-detail"><span class="res-icon">Notes:</span><span><strong>Notes:</strong> ${r.special_requests}</span></div>` : ''}
            </div>
            <div class="res-card-footer">
                <div class="res-contract-actions">
                    ${packageContractUrl ? `<a class="res-contract-link" href="${packageContractUrl}" download>Download Selected Package Contract</a>` : `<span class="res-contract-link disabled">No package contract file assigned yet</span>`}
                    ${signedContract?.contract_url ? `<a class="res-contract-link secondary" href="${signedContract.contract_url}" target="_blank" rel="noopener noreferrer">View Uploaded Signed Contract</a>` : ''}
                </div>
                ${signedContract ? `<p class="res-contract-meta">${verifiedLabel}</p>` : ''}
            </div>
        `;
        list.appendChild(card);
    });
}

function getContractFileForReservation(reservation) {
    const packageName = (reservation.package?.package_name || '').toLowerCase();
    const addOnName = (reservation.add_on?.package_name || '').toLowerCase();
    const locationType = (reservation.location_type || '').toLowerCase();

    if (locationType === 'onsite') {
        if (packageName.includes('vip')) return CONTRACT_FILES.onsite_vip;
        if (packageName.includes('main hall')) return CONTRACT_FILES.onsite_main_hall;
        if (addOnName.includes('snack') || addOnName.includes('biscuit')) return CONTRACT_FILES.add_on_snack;
        return CONTRACT_FILES.onsite_default;
    }

    if (locationType === 'offsite') {
        if (packageName.includes('coffee')) return CONTRACT_FILES.offsite_coffee;
        if (packageName.includes('snack') || packageName.includes('biscuit')) return CONTRACT_FILES.offsite_snack;
        if (packageName.includes('catering')) return CONTRACT_FILES.offsite_catering;
    }

    return CONTRACT_FILES.default;
}

const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

if (profile) {
    document.getElementById('sidebar-name').innerText = `${profile.first_name} ${profile.last_name}`;
    document.getElementById('sidebar-email').innerText = profile.email;

    document.getElementById('profile-first-name').value = profile.first_name || '';
    document.getElementById('profile-middle-name').value = profile.middle_name || '';
    document.getElementById('profile-last-name').value = profile.last_name || '';
    document.getElementById('profile-email').value = profile.email || '';
    document.getElementById('profile-phone').value = profile.phone_number || '';

    const date = new Date(profile.date_registered);
    document.getElementById('profile-date').value = date.toLocaleDateString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

const navItems = document.querySelectorAll('.account-nav-item[data-section]');
const sections = document.querySelectorAll('.account-section');

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const target = item.dataset.section;

        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        sections.forEach(s => s.classList.remove('active'));
        document.getElementById(`section-${target}`).classList.add('active');

        if (target === 'reservations') {
            loadReservations();
        }
    });
});

loadReservations();

document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '../pages/login_signup.html';
});

document.getElementById('profile-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const msg = document.getElementById('profile-msg');

    const { error } = await supabase
        .from('profiles')
        .update({
            first_name: document.getElementById('profile-first-name').value.trim(),
            middle_name: document.getElementById('profile-middle-name').value.trim() || null,
            last_name: document.getElementById('profile-last-name').value.trim(),
            phone_number: document.getElementById('profile-phone').value.trim(),
        })
        .eq('id', user.id);

    if (error) {
        msg.className = 'form-msg error';
        msg.innerText = 'Failed to save changes: ' + error.message;
    } else {
        msg.className = 'form-msg success';
        msg.innerText = 'Profile updated successfully!';

        document.getElementById('sidebar-name').innerText =
            `${document.getElementById('profile-first-name').value} ${document.getElementById('profile-last-name').value}`;
    }
});

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
        msg.innerText = 'Password updated successfully!';
        document.getElementById('password-form').reset();
    }
});
