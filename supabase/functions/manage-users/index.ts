// =====================================================================
// manage-users — lets signed-in SUPERVISORS create logins and reset
// passwords from inside the app.
//
// Deploy: Supabase dashboard > Edge Functions > Deploy a new function >
//         Via Editor > name it  manage-users  > paste this file > Deploy.
// Then open the function's Details/Settings and turn OFF "Verify JWT"
// (this function checks the caller itself, below).
//
// The admin key is provided to the function automatically by Supabase;
// it never reaches the browser.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ROLES = ['employee', 'foreman', 'supervisor'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1) Who is calling? Must be a signed-in, active supervisor.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not signed in.' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'Your session expired. Sign in again.' }, 401);
    const { data: me } = await admin
      .from('profiles').select('role, active').eq('id', userData.user.id).maybeSingle();
    if (!me || !me.active || me.role !== 'supervisor') {
      return json({ error: 'Only supervisors can manage users.' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const password = String(body.password || '');

    // 2) Create a new login
    if (body.action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const fullName = String(body.full_name || '').trim();
      const role = ROLES.includes(body.role) ? body.role : 'employee';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email/login, like jsmith@mabldg-crew.com.' }, 400);
      if (!fullName) return json({ error: 'Enter the person\'s full name.' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: fullName },
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message)
          ? 'That email/login is already in use.' : error.message;
        return json({ error: msg }, 400);
      }
      // The profile row is created automatically by the database trigger;
      // set the name and role on it.
      const { error: pErr } = await admin
        .from('profiles').update({ full_name: fullName, role, active: true }).eq('id', data.user.id);
      if (pErr) return json({ error: 'Login created, but saving name/role failed: ' + pErr.message }, 500);
      return json({ ok: true, id: data.user.id, email });
    }

    // 3) Reset someone's password
    if (body.action === 'reset_password') {
      const userId = String(body.user_id || '');
      if (!userId) return json({ error: 'Missing user.' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
