import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY      = Deno.env.get('RESEND_API_KEY')!
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Verified Vercel domain — used to build absolute links in email bodies.
const SITE_URL = 'https://elicoffee-events.cafe'

// Notifications Configuration Phase 1: which types get emailed used to be
// this hardcoded Set — now it's data-driven via notifications.channel,
// set at insert time by public.dispatch_notification() for the managed
// triggers (supabase/migrations/20260808_notification_config.sql). Rows
// from triggers this feature doesn't manage (admin_* alerts, etc.) still
// default channel='in_app' and are correctly skipped here, same as before.

// ─────────────────────────────────────────────────────────────────────────
// Shared base template — same visual system as the Supabase Auth "Confirm
// your account" email (a dashboard template, not sent from here, but kept
// visually identical on purpose so every ELI Coffee email — auth or
// transactional — looks like it came from the same system). Every
// transactional email sent by this function goes through buildEmailHtml();
// there is exactly one place the chrome (header, divider, sign-off,
// footer) is defined. Callers only ever supply content — eyebrow, title,
// body, and an optional CTA — never markup.
// ─────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface EmailContent {
  eyebrow: string
  title: string
  body: string
  ctaLabel?: string
  ctaUrl?: string
}

function buildEmailHtml({ eyebrow, title, body, ctaLabel, ctaUrl }: EmailContent): string {
  const safeEyebrow = escapeHtml(eyebrow)
  const safeTitle = escapeHtml(title)
  // notification.body is plain text (never contains markup) — escape first,
  // then turn any line breaks into <br> so a multi-line body still reads as
  // separate lines in an email client.
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>')

  const cta = ctaUrl
    ? `
          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="center">
                <a href="${escapeHtml(ctaUrl)}" class="email-button"
                   style="display:inline-block; padding:14px 34px; background-color:#6B4A3A; color:#FFFFFF; text-decoration:none; font-size:14px; font-weight:bold; letter-spacing:0.5px; border-radius:4px;">
                  ${escapeHtml(ctaLabel || 'View Details')}
                </a>
              </td>
            </tr>
          </table>

          <p style="margin:30px 0 10px; font-size:12px; line-height:1.6; color:#8A7D75;">
            If the button above doesn't work, you can also copy and paste this link into your browser.
          </p>

          <p class="email-link" style="margin:0 0 20px; font-size:12px; line-height:1.6; color:#8A7D75; word-break:break-all;">
            ${escapeHtml(ctaUrl)}
          </p>
    `
    : ''

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeTitle}</title>
      <style>
        @media only screen and (max-width: 600px) {
          .email-wrapper { padding: 20px 10px !important; }
          .email-card { width: 100% !important; border-radius: 6px !important; }
          .email-content { padding: 32px 24px 16px !important; }
          .email-divider { margin: 0 24px !important; }
          .email-closing { padding: 20px 24px 30px !important; }
          .email-footer { padding: 18px 16px 8px !important; }
          .email-title { font-size: 26px !important; line-height: 1.3 !important; }
          .email-body { font-size: 14px !important; line-height: 1.65 !important; }
          .email-header { padding: 30px 20px 24px !important; }
          .email-logo { font-size: 22px !important; }
          .email-button { display: block !important; width: auto !important; padding: 14px 24px !important; }
          .email-link { font-size: 11px !important; }
        }
      </style>
    </head>
    <body style="margin:0; padding:0; background-color:#F7F3EE; font-family:Arial, Helvetica, sans-serif; color:#3B302A;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F3EE;">
        <tr>
          <td align="center" class="email-wrapper" style="padding:40px 16px;">

            <table width="100%" cellpadding="0" cellspacing="0" border="0" class="email-card" style="max-width:560px; background-color:#FFFFFF; border-radius:8px; overflow:hidden;">

              <!-- Header -->
              <tr>
                <td align="center" class="email-header" style="padding:36px 30px 28px; background-color:#3B2A22;">
                  <div class="email-logo" style="font-size:26px; font-weight:bold; letter-spacing:2px; color:#F7F3EE;">
                    ELI COFFEE
                  </div>
                  <div style="margin-top:6px; font-size:11px; letter-spacing:2px; color:#D8C7B8; text-transform:uppercase;">
                    Reservation
                  </div>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td class="email-content" style="padding:42px 40px 20px;">

                  <p style="margin:0 0 14px; font-size:13px; letter-spacing:1.5px; color:#9A7965; text-transform:uppercase;">
                    ${safeEyebrow}
                  </p>

                  <h1 class="email-title" style="margin:0 0 20px; font-family:Georgia, 'Times New Roman', serif; font-size:30px; line-height:1.25; font-weight:normal; color:#3B2A22;">
                    ${safeTitle}
                  </h1>

                  <p class="email-body" style="margin:0 0 28px; font-size:15px; line-height:1.7; color:#625750;">
                    ${safeBody}
                  </p>
                  ${cta}
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td class="email-divider" style="padding:0 40px;">
                  <div style="height:1px; background-color:#E9E1DA;"></div>
                </td>
              </tr>

              <!-- Closing -->
              <tr>
                <td class="email-closing" style="padding:24px 40px 38px;">
                  <p style="margin:0 0 6px; font-family:Georgia, 'Times New Roman', serif; font-size:17px; color:#3B2A22;">
                    Thank you for choosing ELI Coffee.
                  </p>
                  <p style="margin:0; font-size:13px; color:#766961;">
                    The ELI Coffee Reservation Team
                  </p>
                </td>
              </tr>

            </table>

            <!-- Footer -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
              <tr>
                <td align="center" class="email-footer" style="padding:22px 20px 10px;">
                  <p style="margin:0 0 8px; font-size:11px; color:#9A8D85;">
                    ELI Coffee &bull; Caf&eacute; &amp; Events
                  </p>
                  <p style="margin:0; font-size:11px; line-height:1.5; color:#AAA09A;">
                    This email was sent because of activity on your ELI Coffee reservation account.
                  </p>
                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

// ─────────────────────────────────────────────────────────────────────────
// Presentation mapping — eyebrow + CTA button label per notification.
// Purely cosmetic: this never changes WHAT is sent (title/body/link are
// already fully determined upstream by the DB triggers/notification_
// template, per file), only how the fixed chrome around them reads. Keyed
// primarily by trigger_code (set for every notification dispatched through
// public.dispatch_notification() — the "managed" trigger catalogue in
// 20260808_notification_config.sql, now 7 entries: reservation_submitted/
// confirmed, payment_received/rejected, reschedule_confirmed,
// cancellation_approved/confirmed — plus the 3 reminder sweeps from
// 20260815_reminder_notifications.sql: payment_due, balance_due,
// event_reminder). Notifications inserted directly with a literal title
// (declined/contract-status/hold-expired/etc. — see each trigger function
// in supabase/migrations) have no trigger_code, so those are matched by
// their fixed title text instead — every literal insert site uses an
// unvarying hardcoded string, confirmed by reading each one.
interface Presentation {
  eyebrow: string
  ctaLabel: string
}

const PRESENTATION_BY_TRIGGER_CODE: Record<string, Presentation> = {
  reservation_submitted:  { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  reservation_confirmed:  { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  payment_received:       { eyebrow: 'Payment',      ctaLabel: 'View payment' },
  payment_rejected:       { eyebrow: 'Payment',      ctaLabel: 'Resubmit payment' },
  reschedule_confirmed:   { eyebrow: 'Reschedule',   ctaLabel: 'Continue payment' },
  cancellation_approved:  { eyebrow: 'Cancellation', ctaLabel: 'Continue payment' },
  cancellation_confirmed: { eyebrow: 'Cancellation', ctaLabel: 'View reservation' },
  payment_due:            { eyebrow: 'Reminder',     ctaLabel: 'Continue payment' },
  balance_due:            { eyebrow: 'Reminder',     ctaLabel: 'Continue payment' },
  event_reminder:         { eyebrow: 'Reminder',     ctaLabel: 'View reservation' },
}

const PRESENTATION_BY_TITLE: Record<string, Presentation> = {
  'Reservation Not Approved':    { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  'Contract Ready to Sign':      { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  'Contract Verified':           { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  'Reservation Complete':        { eyebrow: 'Reservation',  ctaLabel: 'View reservation' },
  'Reschedule Hold Expired':     { eyebrow: 'Reschedule',   ctaLabel: 'View reservation' },
  'Cancellation Finalized':      { eyebrow: 'Cancellation', ctaLabel: 'View reservation' },
  'Contract Rejected':           { eyebrow: 'Contract',     ctaLabel: 'View contract' },
  'Reschedule Request Declined': { eyebrow: 'Reschedule',   ctaLabel: 'View reservation' },
  'Your password was changed':   { eyebrow: 'Security',     ctaLabel: 'View Details' },
}

const DEFAULT_PRESENTATION: Presentation = { eyebrow: 'Reservation', ctaLabel: 'View Details' }

function getPresentation(notification: { trigger_code?: string | null; title?: string | null }): Presentation {
  if (notification.trigger_code && PRESENTATION_BY_TRIGGER_CODE[notification.trigger_code]) {
    return PRESENTATION_BY_TRIGGER_CODE[notification.trigger_code]
  }
  if (notification.title && PRESENTATION_BY_TITLE[notification.title]) {
    return PRESENTATION_BY_TITLE[notification.title]
  }
  return DEFAULT_PRESENTATION
}

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

    const { eyebrow, ctaLabel } = getPresentation(notification)
    const html = buildEmailHtml({
      eyebrow,
      title: notification.title,
      body: notification.body,
      ctaLabel,
      ctaUrl: notification.link ? `${SITE_URL}${notification.link}` : undefined,
    })

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'ELI Coffee Events <notifications@elicoffee-events.cafe>',
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
