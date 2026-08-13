import { NextRequest } from "next/server"
import { handleWhatsAppWebhook } from "@/lib/twilio-webhook"

/**
 * POST /api/twillo/webhook/whatsapp
 * Same as /api/twilio/webhook/whatsapp — use this URL in Twilio:
 * https://dashboard.profitwise.app/api/twillo/webhook/whatsapp
 */
export async function POST(req: NextRequest) {
  return handleWhatsAppWebhook(req)
}
