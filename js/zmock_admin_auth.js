export async function verifyPortalSession() {
  return {
    session: { user: { id: 'staff-mock-1' } },
    profile: {
      user_id: 'staff-mock-1',
      first_name: 'Kim',
      last_name: 'Torres',
      email: 'kim.torres@example.com',
      role: 'staff',
      staff_role: 'kitchen'
    },
    message: ''
  };
}
