import { supabase } from './supabase.js';

// ========================
// Update Navbar Auth Button
// ========================
async function updateNavbar() {
    const { data: { session } } = await supabase.auth.getSession();
    const navBtn = document.querySelector('.navbar__btn');

    if (!navBtn) return;

    if (session && session.user) {
        // User is logged in — fetch their profile to get their first name
        const { data: profile } = await supabase
            .from('profiles')
            .select('first_name')
            .eq('id', session.user.id)
            .single();

        const displayName = profile ? profile.first_name : 'Account';

        navBtn.innerHTML = `
            <div class="nav-account-wrapper">
                <a href="../pages/account.html" class="button"> ${displayName}</a>
                <button class="logout-btn" id="logout-btn">Logout</button>
            </div>
        `;

        // Logout button
        document.getElementById('logout-btn').addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.reload();
        });

    } else {
        // User is not logged in — show default Login / Sign Up
        navBtn.innerHTML = `
            <a href="../pages/login_signup.html" class="button">Login / Sign Up</a>
        `;
    }
}

updateNavbar();