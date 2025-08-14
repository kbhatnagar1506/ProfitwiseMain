import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"

const _inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "ProfitWise – Full Stack AI Accounting firm.",
  description: "ProfitWise – Full Stack AI accounting firm for modern SMBs.",
  generator: "v0.app",
  icons: {
    icon: [
      {
        url: "/icon.png",
      },
    ],
    apple: "/apple-icon.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const isVercel = process.env.VERCEL === "1"
  return (
    <html lang="en">
      <body className={`font-sans antialiased ${_inter.className}`}>
        {children}
        {isVercel && <Analytics />}
      </body>
    </html>
  )
}
