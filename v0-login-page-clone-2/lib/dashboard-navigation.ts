import {
  Home,
  Bell,
  Clock,
  TrendingUp,
  BarChart3,
  Zap,
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
  DollarSign,
  Calculator,
  FileBarChart,
  Sparkles,
  Mail,
  Brain,
  MessageSquare,
  Database,
  Plug,
  Settings,
  LucideIcon,
} from "lucide-react"

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const dashboardNavigation: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Home", href: "/dashboard/home", icon: Home },
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
      { label: "Payment Timing", href: "/dashboard/payment-timing", icon: Clock3 },
    ],
  },
  {
    label: "Receivables",
    items: [
      { label: "Invoices", href: "/dashboard/invoices", icon: FileText },
      { label: "Chase Queue", href: "/dashboard/chase-queue", icon: CheckCircle },
    ],
  },
  {
    label: "Payables",
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
      { label: "Bank Accounts", href: "/dashboard/bank-accounts", icon: CreditCard },
      { label: "Transactions", href: "/dashboard/transactions", icon: ArrowRightLeft },
      { label: "Transfers", href: "/dashboard/transfers", icon: RotateCcw },
    ],
  },
  {
    label: "Accounting",
    items: [
      { label: "Reconciliation", href: "/dashboard/reconciliation", icon: CheckCircle },
      { label: "Review Queue", href: "/dashboard/review-queue", icon: Clock },
      { label: "Books", href: "/dashboard/books", icon: BookOpen },
      { label: "P&L", href: "/dashboard/p-and-l", icon: PieChart },
      { label: "Spend Analysis", href: "/dashboard/spend-analysis", icon: BarChart3 },
      { label: "Tax Prep", href: "/dashboard/tax-prep", icon: Calculator },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "Generate Report", href: "/dashboard/generate-report", icon: FileBarChart },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Entity Profiles", href: "/dashboard/entity-profiles", icon: Sparkles },
      { label: "Gmail Intelligence", href: "/dashboard/gmail-intelligence", icon: Mail },
      { label: "Memory Layer", href: "/dashboard/memory-layer", icon: Brain },
    ],
  },
]

export const bottomBarItems = [
  { label: "Ask ProfitWise", href: "#", icon: MessageSquare },
  { label: "Data Sources", href: "#", icon: Database },
  { label: "Connectors", href: "#", icon: Plug },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
]
