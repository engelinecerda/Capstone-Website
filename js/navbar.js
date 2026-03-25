import { supabase } from './supabase.js';

async function updateNavbar() {
    const { data: { session } } = await supabase.auth.getSession();
    const navBtn = document.querySelector('.navbar__btn');

    if (!navBtn) return;

    if (session && session.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('first_name')
            .eq('id', session.user.id)
            .single();

        const displayName = profile ? profile.first_name : 'Account';

        navBtn.innerHTML = `
            <a href="../pages/account.html" class="button">${displayName}</a>
        `;

    } else {
        navBtn.innerHTML = `
            <a href="../pages/login_signup.html" class="button">Login / Sign Up</a>
        `;
    }
}

updateNavbar();