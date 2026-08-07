import { redirect } from "next/navigation"

/** Single AR/AP dashboard lives at `/payments`; this URL stays for bookmarks. */
export default function ReconciliationRedirectPage() {
  redirect("/payments")
}
