import { NextRequest, NextResponse } from "next/server"
import { verifySlackRequest, getSlackSigningSecret, getSlackBotToken } from "@/lib/slack"
import { getSlackConnectionBySlackUser, claimSlackEventId } from "@/lib/slack-user"
import { getAiReplyForUser } from "@/lib/ai-context-reply"

const SLACK_SCOPE = "chat:write,im:read,im:write,im:history"

type SlackEventPayload = {
  type?: string
  challenge?: string
  team_id?: string
  event_id?: string
  event?: {
    type?: string
    user?: string
    channel?: string
    text?: string
    bot_id?: string
    channel_type?: string
  }
}

/** POST /api/slack/events — Slack Event Subscriptions (url_verification + message.im). */
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-slack-signature") ?? null
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? null
  const signingSecret = getSlackSigningSecret()

  if (signingSecret && !verifySlackRequest(rawBody, signature, timestamp, signingSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let body: SlackEventPayload
  try {
    body = JSON.parse(rawBody) as SlackEventPayload
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // URL verification challenge (required when saving Request URL in Slack app config)
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return NextResponse.json({ challenge: body.challenge })
  }

  if (body.type !== "event_callback" || !body.event) {
    return NextResponse.json({ ok: true })
  }

  const eventId = body.event_id ?? ""
  const claimed = await claimSlackEventId(eventId)
  if (!claimed) {
    return NextResponse.json({ ok: true })
  }

  const event = body.event
  const teamId = body.team_id ?? ""

  if (event.type !== "message" || event.bot_id || !event.user || !event.channel) {
    return NextResponse.json({ ok: true })
  }
  const text = (event.text ?? "").trim()
  if (!text) return NextResponse.json({ ok: true })

  const connection = await getSlackConnectionBySlackUser(event.user, teamId)
  const botToken = connection?.botToken ?? getSlackBotToken()
  if (!botToken) {
    return NextResponse.json({ ok: true })
  }

  let replyText: string
  if (connection) {
    replyText = await getAiReplyForUser(connection.userId, text)
  } else {
    replyText =
      "This Slack account isn’t linked to ProfitWise. Connect Slack in the dashboard (Communication Channels) to use the AI here."
  }

  if (replyText) {
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel: event.channel, text: replyText }),
      })
    } catch {
      // log but don't fail
    }
  }

  return NextResponse.json({ ok: true })
}
