import { ensureSlackSchema, query } from "./db"

/** Claim an event_id so only one dyno/retry processes it. Returns true if we claimed it (first time), false if already seen. */
export async function claimSlackEventId(eventId: string): Promise<boolean> {
  if (!eventId) return true
  await ensureSlackSchema()
  const { rows } = await query<{ event_id: string }>(
    `INSERT INTO slack_events_seen (event_id) VALUES ($1)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId]
  )
  if (rows.length > 0) {
    await query(
      "DELETE FROM slack_events_seen WHERE seen_at < NOW() - INTERVAL '24 hours'"
    ).catch(() => {})
  }
  return rows.length > 0
}

/** Get ProfitWise user id and bot token for a Slack user (for replying). */
export async function getSlackConnectionBySlackUser(
  slackUserId: string,
  slackTeamId: string
): Promise<{ userId: string; botToken: string } | null> {
  await ensureSlackSchema()
  const { rows } = await query<{ user_id: string; bot_token: string }>(
    "SELECT user_id, bot_token FROM user_slack WHERE slack_user_id = $1 AND slack_team_id = $2",
    [slackUserId, slackTeamId]
  )
  const row = rows[0]
  return row ? { userId: row.user_id, botToken: row.bot_token } : null
}

/** Store or update Slack connection for a user (from OAuth callback). */
export async function upsertSlackConnection(
  userId: string,
  slackUserId: string,
  slackTeamId: string,
  botToken: string
): Promise<void> {
  await ensureSlackSchema()
  await query(
    `INSERT INTO user_slack (user_id, slack_user_id, slack_team_id, bot_token, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       slack_user_id = EXCLUDED.slack_user_id,
       slack_team_id = EXCLUDED.slack_team_id,
       bot_token = EXCLUDED.bot_token,
       updated_at = NOW()`,
    [userId, slackUserId, slackTeamId, botToken]
  )
}

/** Get Slack connection status for current user (for UI). */
export async function getSlackStatusByUserId(userId: string): Promise<{ connected: boolean; slackTeamId?: string }> {
  await ensureSlackSchema()
  const { rows } = await query<{ slack_team_id: string }>(
    "SELECT slack_team_id FROM user_slack WHERE user_id = $1",
    [userId]
  )
  const row = rows[0]
  return row ? { connected: true, slackTeamId: row.slack_team_id } : { connected: false }
}

/** Remove Slack connection for user (so they can connect a different workspace). */
export async function disconnectSlack(userId: string): Promise<void> {
  await ensureSlackSchema()
  await query("DELETE FROM user_slack WHERE user_id = $1", [userId])
}
