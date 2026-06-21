// navbar.js
import { customerSupabase as supabase } from './supabase.js';
import { initCustomerNotificationBell } from './notifications.js';

async function updateNavbar() {
    const { data: { session } } = await supabase.auth.getSession();
    const navBtn = document.querySelector('.navbar__btn');

    if (!navBtn) return;

    if (session && session.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('first_name')
            .eq('user_id', session.user.id)
            .single();

        const displayName = profile ? profile.first_name : 'Account';

        // #notifBellMount is the injection point for the notification bell
        navBtn.innerHTML = `
            <span id="notifBellMount"></span>
            <a href="/account.html" class="button">${displayName}</a>
        `;

        initCustomerNotificationBell(supabase, session.user.id);

    } else {
        navBtn.innerHTML = `
            <a href="/login.html" class="button">Login / Sign Up</a>
        `;
    }
}

updateNavbar();
