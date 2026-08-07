import { NextRequest } from "next/server"
import { handleWhatsAppWebhook } from "@/lib/twilio-webhook"

/**
 * POST /api/twilio/webhook/whatsapp
 * Twilio webhook for incoming WhatsApp. Also available at:
 * https://dashboard.profitwise.app/api/twillo/webhook/whatsapp
 */
export async function POST(req: NextRequest) {
  return handleWhatsAppWebhook(req)
}
