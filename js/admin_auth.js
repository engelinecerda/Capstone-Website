export const ADMIN_EMAIL = 'adminelicoffee@gmail.com';

export async function verifyAdminSession(supabase) {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    return {
      session: null,
      message: 'Unable to verify the current session right now.'
    };
  }

  const session = data.session;
  const email = session?.user?.email?.toLowerCase();
  if (!session || email !== ADMIN_EMAIL) {
    return {
      session: null,
      message: 'This account is not allowed to use the admin portal.'
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (profileError) {
    return {
      session: null,
      message: `Unable to verify admin privileges: ${profileError.message}`
    };
  }

  if ((profile?.role || '').toLowerCase() !== 'admin') {
    return {
      session: null,
      message: 'This account signed in successfully, but its profile role is not `admin` in Supabase yet.'
    };
  }

  return { session, profile };
}
