
import { portalSupabase as supabase } from './supabase.js';

export function setupInactivityLogout(role) {
    if (role !== "super_admin") return;

    let timeout;
    const INACTIVITY_LIMIT = 2 * 60 * 60 * 1000; // 2 hours

    function resetTimer() {
        clearTimeout(timeout);
        timeout = setTimeout(async () => {
            alert("Logged out due to inactivity.");
            await supabase.auth.signOut();
            window.location.href = "./admin_login.html";
        }, INACTIVITY_LIMIT);
    }

    ["click", "mousemove", "keydown", "scroll"].forEach(event => {
        document.addEventListener(event, resetTimer);
    });

    resetTimer();
}