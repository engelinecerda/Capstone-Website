import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY      = Deno.env.get('RESEND_API_KEY')!
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Update to your actual deployed site URL
const SITE_URL = 'https://elicoffeeevents.com'

// Notifications Configuration Phase 1: which types get emailed used to be
// this hardcoded Set — now it's data-driven via notifications.channel,
// set at insert time by public.dispatch_notification() for the 7 managed
// triggers (supabase/migrations/20260808_notification_config.sql). Rows
// from triggers this feature doesn't manage (admin_* alerts, etc.) still
// default channel='in_app' and are correctly skipped here, same as before.

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const payload = await req.json()
    // Supabase Database Webhook wraps the row as payload.record
    const notification = payload.record ?? payload

    if (!notification?.id || !notification?.user_id) {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'missing notification data' }),
        { status: 200 }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    if (notification.channel !== 'email') {
      return new Response(
        JSON.stringify({ skipped: true, reason: 'not an email-channel notification' }),
        { status: 200 }
      )
    }

    const { data: { user }, error: userError } =
      await supabase.auth.admin.getUserById(notification.user_id)

    if (userError || !user?.email) {
      console.error('Could not resolve user email:', userError?.message)
      await supabase.from('notifications')
        .update({ status: 'failed', error_message: 'Could not resolve user email' })
        .eq('id', notification.id)
      return new Response(JSON.stringify({ error: 'user not found' }), { status: 200 })
    }

    const ctaButton = notification.link
      ? `<a href="${SITE_URL}${notification.link}"
           style="display:inline-block;margin-top:20px;padding:11px 22px;
                  background:#6b3c11;color:#fff;text-decoration:none;
                  border-radius:6px;font-weight:600;font-size:14px;">
           View Details
         </a>`
      : ''

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin:0;padding:0;background:#f5f0eb;font-family:sans-serif;">
        <div style="max-width:540px;margin:40px auto;background:#fff;border-radius:12px;
                    overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
          <div style="background:#6b3c11;padding:22px 32px;">
            <p style="margin:0;color:#fff;font-weight:700;font-size:15px;">ELI Coffee Events</p>
          </div>
          <div style="padding:30px 32px;">
            <h1 style="margin:0 0 10px;font-size:20px;color:#1a1a1a;">${notification.title}</h1>
            <p style="margin:0;font-size:14px;color:#555;line-height:1.65;">${notification.body}</p>
            ${ctaButton}
          </div>
          <div style="padding:14px 32px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:11px;color:#bbb;">ELI Coffee Events · Rizal, Philippines</p>
          </div>
        </div>
      </body>
      </html>
    `

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'ELI Coffee Events <onboarding@resend.dev>',
        to: [user.email],
        subject: notification.title,
        html,
      }),
    })

    if (!resendRes.ok) {
      const errBody = await resendRes.text()
      console.error('Resend error:', errBody)
      await supabase.from('notifications')
        .update({ status: 'failed', error_message: errBody.slice(0, 500) })
        .eq('id', notification.id)
      return new Response(JSON.stringify({ error: 'email send failed', detail: errBody }), { status: 200 })
    }

    await supabase.from('notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', notification.id)

    return new Response(JSON.stringify({ sent: true, to: user.email }), { status: 200 })

  } catch (err) {
    console.error('send-notification-email error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
