import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Safely parse a value to a float, returning a fallback if the result is NaN.
 * Prevents storing NaN values in the database from malformed input.
 */
export function safeParseFloat(value: unknown, fallback = 0): number {
  const parsed = parseFloat(String(value ?? ""))
  return Number.isNaN(parsed) ? fallback : parsed
}
