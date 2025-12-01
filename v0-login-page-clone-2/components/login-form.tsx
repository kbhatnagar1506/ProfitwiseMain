"use client"

import type React from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? ""

function loadRecaptchaScript(): Promise<void> {
  if (typeof window === "undefined" || !RECAPTCHA_SITE_KEY) return Promise.resolve()
  if ((window as unknown as { grecaptcha?: unknown }).grecaptcha) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("reCAPTCHA failed to load"))
    document.head.appendChild(script)
  })
}

async function getRecaptchaToken(action: string): Promise<string> {
  if (!RECAPTCHA_SITE_KEY || typeof (window as unknown as { grecaptcha?: { execute: (key: string, opts: { action: string }) => Promise<string> } }).grecaptcha?.execute !== "function") {
    return ""
  }
  const grecaptcha = (window as unknown as { grecaptcha: { execute: (key: string, opts: { action: string }) => Promise<string> } }).grecaptcha
  return grecaptcha.execute(RECAPTCHA_SITE_KEY, { action })
}

export function LoginForm() {
  const [email, setEmail] = useState("")
  const [isSignUp, setIsSignUp] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [recaptchaReady, setRecaptchaReady] = useState(!RECAPTCHA_SITE_KEY)
  const router = useRouter()

  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY) {
      setRecaptchaReady(true)
      return
    }
    loadRecaptchaScript()
      .then(() => setRecaptchaReady(true))
      .catch(() => setRecaptchaReady(true))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (isSignUp) {
      if (password !== confirmPassword) {
        setError("Passwords do not match")
        return
      }
      if (password.length < 8) {
        setError("Password must be at least 8 characters")
        return
      }
      if (!/[a-zA-Z]/.test(password)) {
        setError("Password must contain at least one letter")
        return
      }
      if (!/\d/.test(password)) {
        setError("Password must contain at least one number")
        return
      }
    }
    if (!email.trim()) {
      setError("Email is required")
      return
    }
    if (!password) {
      setError("Password is required")
      return
    }
    if (!recaptchaReady) {
      setError("Security check loading. Please wait and try again.")
      return
    }
    setLoading(true)
    try {
      const recaptchaToken = RECAPTCHA_SITE_KEY ? await getRecaptchaToken(isSignUp ? "signup" : "login") : ""
      const url = isSignUp ? "/api/auth/signup" : "/api/auth/login"
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, recaptchaToken: recaptchaToken || undefined }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) {
        setError(data.error ?? (isSignUp ? "Signup failed" : "Login failed"))
        return
      }
      if (isSignUp) {
        router.push("/onboarding")
      } else {
        router.push("/onboarding")
      }
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md mx-auto space-y-4">
      <div className="flex justify-center mb-5">
        <Image
          src="/profitwise-logo.png"
          alt="ProfitWise"
          width={320}
          height={96}
          className="h-20 w-auto object-contain"
        />
      </div>

      {/* Login/Sign up form */}
      <form onSubmit={handleSubmit} className="space-y-4 my-1">
        <div className="space-y-0">
          <label htmlFor="email" className="text-sm text-foreground">
            Email
          </label>
          <Input
            id="email"
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="bg-input border-border text-foreground placeholder:text-muted-foreground h-12"
          />
        </div>

        {!isSignUp && (
          <div className="space-y-0">
            <label htmlFor="login-password" className="text-sm text-foreground">
              Password
            </label>
            <Input
              id="login-password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-input border-border text-foreground placeholder:text-muted-foreground h-12"
            />
          </div>
        )}

        {isSignUp && (
          <>
            <div className="space-y-0">
              <label htmlFor="create-password" className="text-sm text-foreground">
                Create password
              </label>
              <Input
                id="create-password"
                type="password"
                placeholder="Create a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-input border-border text-foreground placeholder:text-muted-foreground h-12"
              />
            </div>
            <div className="space-y-0">
              <label htmlFor="confirm-password" className="text-sm text-foreground">
                Confirm password
              </label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="bg-input border-border text-foreground placeholder:text-muted-foreground h-12"
              />
            </div>
          </>
        )}

        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          className="w-full h-12 bg-white text-black hover:bg-white/90 font-medium"
          disabled={loading}
        >
          {loading ? "Please wait..." : isSignUp ? "Create account" : "Log in"}
        </Button>
      </form>

      <div className="text-center">
        <p className="text-sm text-muted-foreground mx-px py-2">
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-white hover:underline font-medium"
          >
            {isSignUp ? "Log in" : "Sign up"}
          </button>
        </p>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase py-1.5">
          <span className="bg-background px-2 text-muted-foreground">OR</span>
        </div>
      </div>

      {/* OAuth buttons */}
      <div className="space-y-3">
        <Button
          type="button"
          variant="outline"
          className="w-full h-12 bg-transparent border-border text-foreground hover:bg-secondary"
          onClick={() => {}}
        >
          <Image
            src="/google-icon.png"
            alt="Google"
            width={20}
            height={20}
            className="mr-2 h-5 w-5"
          />
          Continue with Google
        </Button>

        <Button
          type="button"
          variant="outline"
          className="w-full h-12 bg-transparent border-border text-foreground hover:bg-secondary"
          onClick={() => {}}
        >
          <Image
            src="/apple-icon.png"
            alt="Apple"
            width={20}
            height={20}
            className="mr-2 h-5 w-5"
          />
          Continue with Apple
        </Button>
      </div>

      {/* Footer text */}
      <p className="text-center text-sm text-muted-foreground py-1.5">
        By continuing, you agree to our{" "}
        <a href="#" className="underline hover:text-foreground">
          Terms
        </a>{" "}
        and{" "}
        <a href="#" className="underline hover:text-foreground">
          Privacy Policy
        </a>
        .
      </p>
    </div>
  )
}

