import { LoginForm } from "@/components/login-form"
import { Navigation } from "@/components/navigation"
import { Footer } from "@/components/footer"

export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col bg-black">
      <Navigation />

      <div className="flex-1 flex items-center justify-center p-2 md:p-4 mt-0">
        <div className="w-full max-w-md">
          <LoginForm />
        </div>
      </div>

      <Footer />
    </div>
  )
}
