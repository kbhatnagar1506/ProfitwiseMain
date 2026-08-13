import {
  Home,
  Bell,
  Clock,
  TrendingUp,
  BarChart3,
  Calendar,
  Clock3,
  FileText,
  CheckCircle,
  Users,
  UserCheck,
  Phone,
  CreditCard,
  ArrowRightLeft,
  RotateCcw,
  BookOpen,
  PieChart,
  Calculator,
  FileBarChart,
  Sparkles,
  Mail,
  Brain,
  MessageSquare,
  Plug,
  Settings,
  LayoutGrid,
  Zap,
  Search,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  badge?: number
  badgeColor?: "red" | "green" | "amber"
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const dashboardNavigation: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Home", href: "/dashboard/home", icon: LayoutGrid },
      { label: "Alerts", href: "/dashboard/alerts", icon: Bell },
      { label: "Activity Log", href: "/dashboard/activity-log", icon: Clock },
    ],
  },
  {
    label: "Cash",
    items: [
      { label: "Cashflow", href: "/dashboard/cashflow", icon: TrendingUp },
      { label: "Forecast", href: "/dashboard/forecast", icon: BarChart3 },
      { label: "Scenarios", href: "/dashboard/scenarios", icon: Zap },
      { label: "Runway", href: "/dashboard/runway", icon: Calendar },
      { label: "Payment timing", href: "/dashboard/payment-timing", icon: Clock3 },
    ],
  },
  {
    label: "Receivables (AR)",
    items: [
      { label: "Invoices", href: "/dashboard/invoices", icon: FileText },
      { label: "Chase queue", href: "/dashboard/chase-queue", icon: CheckCircle },
    ],
  },
  {
    label: "Payables (AP)",
    items: [
      { label: "Bills", href: "/dashboard/bills", icon: FileText },
      { label: "Vendors", href: "/dashboard/vendors", icon: Users },
    ],
  },
  {
    label: "Relationships",
    items: [
      { label: "Customers", href: "/dashboard/customers", icon: UserCheck },
      { label: "Contacts", href: "/dashboard/contacts", icon: Phone },
    ],
  },
  {
    label: "Banking",
    items: [
      { label: "Bank accounts", href: "/dashboard/bank-accounts", icon: CreditCard },
      { label: "Transactions", href: "/dashboard/transactions", icon: ArrowRightLeft },
      { label: "Transfers", href: "/dashboard/transfers", icon: RotateCcw },
    ],
  },
  {
    label: "Accounting",
    items: [
      { label: "Reconciliation", href: "/dashboard/reconciliation", icon: CheckCircle },
      { label: "Recon Candidates", href: "/dashboard/reconciliation-candidates", icon: Search },
      { label: "Review queue", href: "/dashboard/review-queue", icon: Clock },
      { label: "Books", href: "/dashboard/books", icon: BookOpen },
      { label: "P&L", href: "/dashboard/p-and-l", icon: PieChart },
      { label: "Spend analysis", href: "/dashboard/spend-analysis", icon: BarChart3 },
      { label: "Tax prep", href: "/dashboard/tax-prep", icon: Calculator },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "Generate report", href: "/dashboard/generate-report", icon: FileBarChart },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Entity profiles", href: "/dashboard/entity-profiles", icon: Sparkles },
      { label: "Gmail intelligence", href: "/dashboard/gmail-intelligence", icon: Mail },
      { label: "Memory layer", href: "/dashboard/memory-layer", icon: Brain },
    ],
  },
]

export const bottomBarItems = [
  { label: "Ask ProfitWise", href: "#", icon: MessageSquare },
  { label: "Connectors", href: "#", icon: Plug },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
]
