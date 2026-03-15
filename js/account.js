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
    });
});

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

    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-new-password').value;

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