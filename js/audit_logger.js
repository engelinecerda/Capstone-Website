// audit_logger.js
// Lightweight audit logging — safe to import from any page

import { portalSupabase as supabase } from './supabase.js';

export async function logAudit({ action, category, details, entityId }) {
  try {
    const { data: { user } } = await supabase.auth.getUser();

    let userName = 'Unknown';
    let userRole = 'Unknown';
    let userId   = null;

    if (user) {
      userId = user.id;

      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, role, staff_role')
        .eq('user_id', user.id)
        .single();

      if (profile) {
        const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
        const effectiveRole = (profile.staff_role || profile.role || '').toLowerCase();

        userName = fullName || user.email;

        if (effectiveRole === 'admin') {
            userRole = 'Admin';
        } else if (effectiveRole === 'manager') {
            userRole = 'Manager';
        } else if (effectiveRole === 'staff') {
            userRole = 'Staff';
        }
        
      } else {
        userName = user.email;
      }
    }

    const { error } = await supabase.from('audit_log').insert({
      user_id:   userId,
      user_name: userName,
      user_role: userRole,
      action:    action,
      category:  category || 'system',
      details:   details || null,
      entity_id: entityId || null,
    });

    if (error) console.error('Failed to log audit:', error);
  } catch (err) {
    console.error('Audit log error:', err);
  }
}