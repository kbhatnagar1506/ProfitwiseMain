import { Configuration, PlaidApi, PlaidEnvironments } from "plaid"
import { log } from "./logger"

export function getPlaidWebhookUrl(): string {
  const base = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://dashboard.profitwise.app"
  return `${base.replace(/\/$/, "")}/api/plaid/webhook`
}

function getPlaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  if (!clientId || !secret) throw new Error("Plaid not configured: PLAID_CLIENT_ID and PLAID_SECRET required")
  const env = process.env.PLAID_ENV === "sandbox" ? PlaidEnvironments.sandbox : PlaidEnvironments.production
  return {
    clientId,
    secret,
    basePath: env,
  }
}

let plaidClient: PlaidApi | null = null

export function getPlaidClient(): PlaidApi {
  if (!plaidClient) {
    const { basePath, clientId, secret } = getPlaidConfig()
    const configuration = new Configuration({
      basePath,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    })
    plaidClient = new PlaidApi(configuration)
  }
  return plaidClient
}

export function isPlaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}

export async function createLinkToken(): Promise<string> {
  const client = getPlaidClient()
  const webhookUrl = getPlaidWebhookUrl()
  const response = await client.linkTokenCreate({
    user: { client_user_id: "profitwise-user" },
    client_name: "ProfitWise",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    country_codes: ["US"],
    language: "en",
    webhook: webhookUrl,
  })
  const linkToken = response.data.link_token
  if (!linkToken) throw new Error("Plaid link_token missing")
  log("link_token.create.succeeded", { webhookUrl }, "plaid")
  return linkToken
}

export async function exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
  const client = getPlaidClient()
  const response = await client.itemPublicTokenExchange({ public_token: publicToken })
  const accessToken = response.data.access_token
  const itemId = response.data.item_id
  if (!accessToken || !itemId) throw new Error("Plaid exchange missing access_token or item_id")
  return { accessToken, itemId }
}

export type PlaidAccount = {
  account_id: string
  name: string
  type: string
  subtype: string | null
  mask: string | null
  current_balance: number | null
  available_balance: number | null
  currency_code: string | null
}

export async function getAccounts(accessToken: string): Promise<PlaidAccount[]> {
  const client = getPlaidClient()
  const response = await client.accountsGet({ access_token: accessToken })
  const accounts = response.data.accounts ?? []
  return accounts.map((a) => ({
    account_id: a.account_id,
    name: a.name,
    type: (a as { type?: string }).type ?? "unknown",
    subtype: (a as { subtype?: string | null }).subtype ?? null,
    mask: a.mask ?? null,
    current_balance: a.balances?.current ?? null,
    available_balance: a.balances?.available ?? null,
    currency_code: a.balances?.iso_currency_code ?? a.balances?.unofficial_currency_code ?? null,
  }))
}
