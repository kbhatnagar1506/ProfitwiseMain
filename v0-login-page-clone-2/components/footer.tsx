export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-white/10 text-xs md:text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-5 md:py-6">
        <p className="whitespace-nowrap">© {year} ProfitWise Inc. All rights reserved.</p>

        <div className="flex items-center gap-4">
          <a href="/terms" className="hover:text-foreground">
            Terms &amp; Conditions
          </a>
          <span className="h-4 w-px bg-white/10" />
          <a href="/privacy" className="hover:text-foreground">
            Privacy Policy
          </a>
        </div>
      </div>
    </footer>
  )
}

