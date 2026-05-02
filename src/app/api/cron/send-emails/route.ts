import { NextResponse, type NextRequest } from "next/server";

/**
 * Hourly cron — sends pending emails whose send_at <= now().
 *
 * Logic (per spec):
 *  1. Fetch emails WHERE status = 'pending' AND send_at <= now()
 *  2. Per email:
 *     - if lead has replied → skip + cancel remaining steps
 *     - if lead unsubscribed → skip
 *     - send via Resend
 *     - update status='sent', log email_sent
 *     - create next step's email row with send_at = now() + delay_days
 *
 * Runs from Vercel cron via vercel.json. Authenticated by CRON_SECRET header.
 * Implementation lands in the next pass.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return NextResponse.json({ ok: true, processed: 0 });
}
