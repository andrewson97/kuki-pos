import { getDb } from "../db/database";

interface PrintReceiptData {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  tokenNumber: number;
  billDate: string;
  items: { name: string; qty: number; price: number; total: number }[];
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  paymentMethod: string;
  cashierName: string;
  customerName?: string;
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
  const w = 32; // 58mm printer ~ 32 chars

  const center = (text: string) => {
    const pad = Math.max(0, Math.floor((w - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  lines.push(center(data.shopName));
  if (data.shopAddress) lines.push(center(data.shopAddress));
  if (data.shopPhone) lines.push(center(`Tel: ${data.shopPhone}`));
  lines.push("-".repeat(w));
  lines.push(`Token: #${String(data.tokenNumber).padStart(3, "0")}`);
  lines.push(`Date: ${data.billDate}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  lines.push("-".repeat(w));

  // Header
  lines.push("Item              Qty   Amount");
  lines.push("-".repeat(w));

  for (const item of data.items) {
    const name = item.name.length > 16 ? item.name.substring(0, 16) : item.name.padEnd(16);
    const qty = String(item.qty).padStart(3);
    const amt = item.total.toFixed(2).padStart(9);
    lines.push(`${name}  ${qty}  ${amt}`);
  }

  lines.push("-".repeat(w));
  lines.push(`${"Subtotal".padEnd(20)} ${data.subtotal.toFixed(2).padStart(10)}`);
  if (data.discount > 0) {
    lines.push(`${"Discount".padEnd(20)} -${data.discount.toFixed(2).padStart(9)}`);
  }
  if (data.taxAmount > 0) {
    lines.push(`${`Tax (${data.taxRate}%)`.padEnd(20)} ${data.taxAmount.toFixed(2).padStart(10)}`);
  }
  lines.push("=".repeat(w));
  lines.push(`${"TOTAL".padEnd(20)} ${data.total.toFixed(2).padStart(10)}`);
  lines.push(`${"Payment".padEnd(20)} ${data.paymentMethod.toUpperCase().padStart(10)}`);
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
  const w = 32;
  const center = (text: string) => {
    const pad = Math.max(0, Math.floor((w - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  lines.push(center(data.shopName));
  lines.push(center("*** KITCHEN COPY ***"));
  lines.push("=".repeat(w));
  lines.push(`Token: #${String(data.tokenNumber).padStart(3, "0")}`);
  lines.push(`Date:  ${data.billDate}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  lines.push("-".repeat(w));
  lines.push("Qty  Item");
  lines.push("-".repeat(w));
  for (const item of data.items) {
    const qty = String(item.qty).padEnd(4);
    const name = item.name.length > 27 ? item.name.substring(0, 27) : item.name;
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
