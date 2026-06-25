// navbar.js
import { customerSupabase as supabase } from './supabase.js';
import { initCustomerNotificationBell } from './notifications.js';

async function updateNavbar() {
    const { data: { session } } = await supabase.auth.getSession();
    const navBtn = document.querySelector('.navbar__btn');
    const navMenu = document.querySelector('.navbar__menu');
    const navTopbarRight = document.getElementById('navTopbarRight');

    if (!navBtn) return;

    if (session && session.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('first_name')
            .eq('user_id', session.user.id)
            .single();

        const displayName = profile ? profile.first_name : 'Account';

        // Mobile drawer: inject greeting linking to account page
        if (navMenu) {
            const greeting = document.createElement('li');
            greeting.className = 'navbar__greeting';
            greeting.innerHTML = `
                <a href="/account.html" class="navbar__greeting-link">
                    <span>Hi, ${displayName}!</span>
                    <span class="navbar__greeting-account-hint">My Account ›</span>
                </a>`;
            navMenu.insertBefore(greeting, navMenu.firstChild);
        }

        navBtn.innerHTML = `<a href="/account.html" class="button">${displayName}</a>`;
        document.body.classList.add('user-logged-in');

        // Bell lives in navTopbarRight — always in the topbar on mobile (never inside
        // the collapsible menu). Move it to end of container so on desktop it appears
        // right after the Engeline button at the right edge of the navbar.
        if (navTopbarRight) {
            const navContainer = document.querySelector('.navbar__container');
            if (navContainer) navContainer.appendChild(navTopbarRight);
            navTopbarRight.innerHTML = `<span id="notifBellMount"></span>`;
        }

        initCustomerNotificationBell(supabase, session.user.id);

    } else {
        navBtn.innerHTML = `<a href="/login.html" class="button">Login / Sign Up</a>`;
    }
}

updateNavbar();
