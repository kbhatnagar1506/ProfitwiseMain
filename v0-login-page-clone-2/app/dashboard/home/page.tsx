import { TrendingUp, TrendingDown, ArrowRight } from "lucide-react"

export default function HomePage() {
  const stats = [
    { label: "Total Cash", value: "$308.71", change: "+12.5%", up: true },
    { label: "Monthly Forecast", value: "$45,230", change: "+8.2%", up: true },
    { label: "Pending Invoices", value: "$12,450", change: "-3.1%", up: false },
    { label: "Outstanding Bills", value: "$8,920", change: "+5.4%", up: true },
  ]

  const recentActivity = [
    { type: "Invoice", description: "Invoice #1042 sent to Acme Corp", amount: "$2,400", time: "2h ago" },
    { type: "Payment", description: "Payment received from TechStart Inc", amount: "$5,200", time: "4h ago" },
    { type: "Bill", description: "AWS bill due in 3 days", amount: "$890", time: "6h ago" },
    { type: "Forecast", description: "Cash forecast updated for April", amount: "", time: "1d ago" },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Dashboard</h1>
        <p className="text-sm text-neutral-500 mt-1">Welcome back to ProfitWise</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((card) => (
          <div key={card.label} className="bg-[#141414] border border-white/[0.06] rounded-xl p-5 hover:border-white/[0.1] transition-colors">
            <p className="text-[13px] text-neutral-500 font-medium">{card.label}</p>
            <p className="text-2xl font-semibold text-foreground mt-2 tracking-tight">{card.value}</p>
            <div className="flex items-center gap-1.5 mt-3">
              {card.up ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-400" />
              )}
              <span className={`text-xs font-medium ${card.up ? "text-emerald-500" : "text-red-400"}`}>
                {card.change}
              </span>
              <span className="text-[11px] text-neutral-600 ml-1">vs last month</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-[#141414] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Recent Activity</h2>
            <button className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="space-y-1">
            {recentActivity.map((item, i) => (
              <div key={i} className="flex items-center justify-between py-2.5 px-2 rounded-lg hover:bg-white/[0.03] transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.05] flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-bold text-neutral-500 uppercase">{item.type.slice(0, 2)}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] text-neutral-300 truncate">{item.description}</p>
                    <p className="text-[11px] text-neutral-600">{item.time}</p>
                  </div>
                </div>
                {item.amount && (
                  <span className="text-[13px] font-medium text-neutral-400 flex-shrink-0 ml-4">{item.amount}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#141414] border border-white/[0.06] rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Quick Actions</h2>
          <div className="space-y-2">
            {[
              "Create invoice",
              "Record payment",
              "Run forecast",
              "Generate report",
            ].map((action) => (
              <button
                key={action}
                className="w-full flex items-center justify-between px-3 py-2.5 text-[13px] text-neutral-400 rounded-lg border border-white/[0.06] hover:border-white/[0.1] hover:text-neutral-200 hover:bg-white/[0.03] transition-all"
              >
                {action}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
