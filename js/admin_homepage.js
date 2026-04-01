import { supabase } from './supabase.js';

const ADMIN_EMAIL = 'adminelicoffee@gmail.com';
const adminEmail = document.getElementById('adminEmail');
const adminStatus = document.getElementById('adminStatus');
const logoutBtn = document.getElementById('logoutBtn');

function redirectToAdminLogin() {
    window.location.replace('./admin_login.html');
}

async function validateAdminSession() {
    const { data, error } = await supabase.auth.getSession();

    if (error) {
        redirectToAdminLogin();
        return;
    }

    const session = data.session;
    const email = session?.user?.email?.toLowerCase();

    if (!session || email !== ADMIN_EMAIL) {
        await supabase.auth.signOut();
        redirectToAdminLogin();
        return;
    }

    if (adminEmail) {
        adminEmail.textContent = session.user.email;
    }

    if (adminStatus) {
        adminStatus.textContent = 'Authenticated';
    }
}

logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    redirectToAdminLogin();
});

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        redirectToAdminLogin();
    }
});

validateAdminSession();
