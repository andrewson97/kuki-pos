import { getDb } from "../db/database";

interface PrintReceiptData {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  tokenNumber: number;
  billDate: string;
  items: { name: string; qty: number; price: number; total: number; original_price?: number }[];
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  paymentMethod: string;
  cashierName: string;
  customerName?: string;
  amountGiven?: number | null;
  changeGiven?: number | null;
}

export function getSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export function buildReceiptText(data: PrintReceiptData): string {
  const lines: string[] = [];
  const w = 28; // 57mm printer ~ 28 chars at 13px monospace

  const center = (text: string) => {
    const pad = Math.max(0, Math.floor((w - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  // Shop name is shown via the logo image above the text, so don't repeat it here.
  if (data.shopAddress) lines.push(center(data.shopAddress));
  if (data.shopPhone) lines.push(center(`Tel: ${data.shopPhone}`));
  if (data.shopAddress || data.shopPhone) lines.push("-".repeat(w));
  lines.push(`Token: #${String(data.tokenNumber).padStart(3, "0")}`);
  lines.push(`Date: ${data.billDate}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  lines.push("-".repeat(w));

  // Header — columns sum to w=28: name(14)+sp+qty(3)+sp+amt(9)
  lines.push(`${"Item".padEnd(14)} ${"Qty".padStart(3)} ${"Amount".padStart(9)}`);
  lines.push("-".repeat(w));

  let totalSavings = 0;
  for (const item of data.items) {
    const name = item.name.length > 14 ? item.name.substring(0, 14) : item.name.padEnd(14);
    const qty = String(item.qty).padStart(3);
    const amt = item.total.toFixed(2).padStart(9);
    lines.push(`${name} ${qty} ${amt}`);
    if (item.original_price && item.original_price > item.price) {
      const saved = (item.original_price - item.price) * item.qty;
      totalSavings += saved;
      lines.push(`  was@${item.original_price.toFixed(2)} save ${saved.toFixed(2)}`);
    }
  }

  // Totals — left label padEnd(17) + space + value padStart(10) = 28
  lines.push("-".repeat(w));
  const totalLine = (label: string, value: number, neg = false) =>
    `${label.padEnd(17)} ${(neg ? "-" : "") + value.toFixed(2)}`.padEnd(28);
  if (totalSavings > 0) lines.push(totalLine("Item Savings", totalSavings, true));
  lines.push(totalLine("Subtotal", data.subtotal));
  if (data.discount > 0) lines.push(totalLine("Discount", data.discount, true));
  if (data.taxAmount > 0) lines.push(totalLine(`Tax (${data.taxRate}%)`, data.taxAmount));
  lines.push("=".repeat(w));
  lines.push(totalLine("TOTAL", data.total));
  lines.push(`${"Payment".padEnd(17)} ${data.paymentMethod.toUpperCase().padStart(10)}`);
  if (data.amountGiven != null) {
    lines.push(totalLine("Cash Given", data.amountGiven));
    lines.push(totalLine("Change", data.changeGiven ?? 0));
  }
  lines.push("=".repeat(w));
  lines.push("");
  lines.push(center("Thank you!"));
  lines.push(center("Visit again!"));
  lines.push("");
  lines.push(`Cashier: ${data.cashierName}`);

  return lines.join("\n");
}

export function buildKitchenTicket(data: PrintReceiptData): string {
  const lines: string[] = [];
  const w = 28;
  const center = (text: string) => {
    const pad = Math.max(0, Math.floor((w - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  lines.push(center("*** KITCHEN COPY ***"));
  lines.push("=".repeat(w));
  lines.push(`Token: #${String(data.tokenNumber).padStart(3, "0")}`);
  lines.push(`Date:  ${data.billDate}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  lines.push("-".repeat(w));
  lines.push("Qty  Item");
  lines.push("-".repeat(w));
  for (const item of data.items) {
    const qty = String(item.qty).padEnd(3);
    const name = item.name.length > 24 ? item.name.substring(0, 24) : item.name;
    lines.push(`${qty} ${name}`);
  }
  lines.push("=".repeat(w));
  lines.push("");
  return lines.join("\n");
}

// Thermal printing via raw ESC/POS commands to a Windows shared printer
export async function printReceipt(data: PrintReceiptData): Promise<{ success: boolean; text: string; error?: string }> {
  const text = buildReceiptText(data);
  const settings = getSettings();

  if (settings.printer_type === "none") {
    return { success: true, text, error: "No printer configured - receipt text generated only" };
  }

  // For Windows: use the `net use` printer share or direct USB via printer name
  // We'll generate the text and use a simple file-write approach to the printer port
  try {
    const printerAddress = settings.printer_address || "";
    if (!printerAddress) {
      return { success: false, text, error: "No printer address configured" };
    }

    // ESC/POS: Initialize + text + cut + open cash drawer
    const ESC = "\x1B";
    const GS = "\x1D";
    const init = `${ESC}@`; // Initialize printer
    const cut = `${GS}V\x00`; // Full cut
    const rawData = `${init}${text}\n\n\n${cut}`;

    // Write to printer (Windows shared printer or USB)
    await Bun.write(printerAddress, rawData);
    return { success: true, text };
  } catch (err: any) {
    return { success: false, text, error: err.message };
  }
}
