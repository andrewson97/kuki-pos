export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function formatCurrency(amount: number, symbol: string = "₹"): string {
  return `${symbol}${amount.toFixed(2)}`;
}

const TZ = "Asia/Colombo";

function parseDb(date: string): Date {
  if (!date) return new Date(NaN);
  if (date instanceof Date) return date;
  // SQLite "YYYY-MM-DD HH:MM:SS" is UTC; ensure JS parses it as UTC.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(date)) return new Date(date);
  return new Date(date.replace(" ", "T") + "Z");
}

export function formatDate(date: string): string {
  return parseDb(date).toLocaleDateString("en-LK", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: string): string {
  return parseDb(date).toLocaleString("en-LK", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Today's date in Sri Lanka (YYYY-MM-DD).
export function todayDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

export function nowISO(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}
