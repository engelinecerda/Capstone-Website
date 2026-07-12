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
            const initial = displayName.charAt(0).toUpperCase();
            const greeting = document.createElement('li');
            greeting.className = 'navbar__greeting';
            greeting.innerHTML = `
                <a href="/account.html" class="navbar__greeting-link">
                    <div class="navbar__greeting-avatar">${initial}</div>
                    <div class="navbar__greeting-text">
                        <span class="navbar__greeting-name">Hi, ${displayName}!</span>
                        <span class="navbar__greeting-account-hint">My Account ›</span>
                    </div>
                </a>`;
            const drawerHeader = navMenu.querySelector('.nav-drawer-header');
            if (drawerHeader) {
                drawerHeader.insertAdjacentElement('afterend', greeting);
            } else {
                navMenu.insertBefore(greeting, navMenu.firstChild);
            }
        }

        navBtn.innerHTML = `
            <div class="navbar__account-dropdown">
                <button type="button" class="navbar__account-trigger" id="navbarAccountTrigger" aria-haspopup="true" aria-expanded="false" aria-label="Account menu for ${displayName}">
                    <span>Account</span>
                    <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>
                <div class="navbar__account-menu" id="navbarAccountMenu" role="menu">
                    <a href="/account.html" class="navbar__account-menu-item" role="menuitem">
                        <i class="fa-solid fa-user" aria-hidden="true"></i> My Profile
                    </a>
                    <a href="/account.html?section=reservations" class="navbar__account-menu-item" role="menuitem">
                        <i class="fa-solid fa-calendar-check" aria-hidden="true"></i> My Reservations
                    </a>
                    <div class="navbar__account-menu-divider" role="separator"></div>
                    <button type="button" class="navbar__account-menu-item navbar__account-menu-item--logout" id="navbarLogoutBtn" role="menuitem">
                        <i class="fa-solid fa-arrow-right-from-bracket" aria-hidden="true"></i> Logout
                    </button>
                </div>
            </div>
        `;
        document.body.classList.add('user-logged-in');

        const accountTrigger = document.getElementById('navbarAccountTrigger');
        const accountMenu = document.getElementById('navbarAccountMenu');
        const accountDropdown = accountTrigger?.closest('.navbar__account-dropdown');

        const closeAccountMenu = () => {
            accountDropdown?.classList.remove('open');
            accountTrigger?.setAttribute('aria-expanded', 'false');
        };

        accountTrigger?.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = accountDropdown?.classList.toggle('open');
            accountTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });

        document.addEventListener('click', (event) => {
            if (accountDropdown && !accountDropdown.contains(event.target)) {
                closeAccountMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeAccountMenu();
        });

        document.getElementById('navbarLogoutBtn')?.addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.href = '/login.html';
        });

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
        navBtn.innerHTML = `<a href="/login.html" class="button">Login</a>`;
    }
}

updateNavbar();
