export default function HomePage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-4xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-2">Welcome back to ProfitWise</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Cash", value: "$308.71", change: "+12.5%" },
          { label: "Monthly Forecast", value: "$45,230", change: "+8.2%" },
          { label: "Pending Invoices", value: "$12,450", change: "-3.1%" },
          { label: "Outstanding Bills", value: "$8,920", change: "+5.4%" },
        ].map((card) => (
          <div key={card.label} className="bg-card border border-border rounded-lg p-6">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="text-2xl font-bold text-foreground mt-2">{card.value}</p>
            <p className="text-xs text-green-600 mt-2">{card.change}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
