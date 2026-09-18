// ─── Sompitra DB Schema Types ──────────────────────────────
// Mirrors every table in 0001_initial_schema.sql

export interface User {
  id: string
  username: string
  display_name: string
  pin_hash: string
  is_admin: number
  created_at: string
}

export interface Session {
  id: string
  user_id: string
  token: string
  expires_at: string
  created_at: string
}

export interface IncomeAccount {
  id: string
  user_id: string
  name: string
  is_protected: number
  created_at: string
}

export interface CategoryGroup {
  id: string
  name: string
  sort_order: number
  created_at: string
}

export interface Category {
  id: string
  group_id: string
  name: string
  target_budget: number
  sort_order: number
  created_at: string
  // joined
  group_name?: string
}

export interface Transaction {
  id: string
  date: string
  amount: number
  type: 'income' | 'expense'
  income_account_id: string | null
  category_id: string | null
  description: string | null
  notes: string | null
  added_by_user_id: string
  is_recurring: number
  created_at: string
  // joined
  category_name?: string
  group_name?: string
  income_account_name?: string
  added_by_display_name?: string
}

export interface DebtCreditAccount {
  id: string
  person_name: string
  type: 'debt' | 'credit'
  initial_amount: number
  current_balance: number
  notes: string | null
  income_account_id: string | null
  category_id: string | null
  synced_transaction_id: string | null
  created_at: string
}

export interface DebtCreditPayment {
  id: string
  account_id: string
  amount: number
  payment_date: string
  synced_transaction_id: string | null
  notes: string | null
  created_at: string
}

export interface Customer {
  id: string
  name: string
  phone: string | null
  default_rate: number
  notes: string | null
  created_at: string
}

export interface ServiceContract {
  id: string
  customer_id: string
  title: string
  session_rate: number
  total_scheduled: number
  status: 'active' | 'completed' | 'cancelled'
  start_date: string
  end_date: string | null
  created_at: string
  // joined
  customer_name?: string
  delivered_count?: number
  paid_amount?: number
}

export interface AttendanceTick {
  id: string
  contract_id: string
  tick_date: string
  is_delivered: number
}

export interface ClientPayment {
  id: string
  contract_id: string
  amount: number
  payment_date: string
  synced_transaction_id: string | null
  notes: string | null
  created_at: string
}

export interface InventoryItem {
  id: string
  name: string
  cost_price: number
  sale_price: number
  stock_qty: number
  notes: string | null
  created_at: string
}

export interface SaleRecord {
  id: string
  item_id: string
  qty: number
  total_sale: number
  total_cost: number
  sale_date: string
  synced_income_txn_id: string | null
  synced_expense_txn_id: string | null
  notes: string | null
  created_at: string
}

// ─── Cloudflare Worker binding type ──────────────────────────
// The merged Worker's full binding set lives in src/env.ts; Sompitra's
// routes consume it through this re-export.
export type { Env } from '../env'
