export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function formatCurrency(amount: number, symbol: string = "₹"): string {
  return `${symbol}${amount.toFixed(2)}`;
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export function nowISO(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}
