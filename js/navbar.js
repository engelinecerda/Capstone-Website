import { customerSupabase as supabase } from './supabase.js';

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

        navBtn.innerHTML = `
            <a href="/account" class="button">${displayName}</a>
        `;

    } else {
        navBtn.innerHTML = `
            <a href="/login" class="button">Login / Sign Up</a>
        `;
    }
}

updateNavbar();
