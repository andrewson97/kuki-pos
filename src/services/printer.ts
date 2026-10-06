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
    const qty = String(item.qty).padStart(3);
    const amt = item.total.toFixed(2).padStart(9);
    if (item.name.length <= 14) {
      // Fits on one line with qty/amt to the right.
      lines.push(`${item.name.padEnd(14)} ${qty} ${amt}`);
    } else {
      // Print full name (wrapping at 28 chars), then qty/amt right-aligned on next line.
      for (let i = 0; i < item.name.length; i += w) {
        lines.push(item.name.substring(i, i + w));
      }
      lines.push(`${" ".repeat(14)} ${qty} ${amt}`);
    }
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
  lines.push(center("Thank you! Visit again!"));
  lines.push(center("+94 76 565 2881"));

  return lines.join("\n");
}

// A proforma is the slip handed over BEFORE the money changes hands: the customer
// reads the amount, pays at the counter, and only then is a real bill rung up.
// Nothing is stored when this is printed — there is no token, no payment method
// and no change to show, so those fields are absent from the data on purpose.
interface PrintProformaData {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  billDate: string;
  items: { name: string; qty: number; price: number; total: number; original_price?: number }[];
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  customerName?: string;
}

// Deliberately the same width, column widths and totals alignment as
// buildReceiptText() so both slips come off the same thermal printer looking
// like one shop's stationery. What differs is only what must differ: a title,
// a disclaimer, no token, and a "pay at the counter" close instead of a
// thank-you — nothing here may read as proof that the sale happened.
export function buildProformaText(data: PrintProformaData): string {
  const lines: string[] = [];
  const w = 28; // 57mm printer ~ 28 chars at 13px monospace

  const center = (text: string) => {
    const pad = Math.max(0, Math.floor((w - text.length) / 2));
    return " ".repeat(pad) + text;
  };

  // Unlike the receipt, the shop name IS printed here: the proforma is printed
  // without the logo image (see the POS views), so this is the only line that
  // says whose bill the customer is holding.
  if (data.shopName) lines.push(center(data.shopName));
  if (data.shopAddress) lines.push(center(data.shopAddress));
  if (data.shopPhone) lines.push(center(`Tel: ${data.shopPhone}`));
  lines.push("=".repeat(w));
  lines.push(center("PROFORMA INVOICE"));
  lines.push(center("NOT A RECEIPT"));
  lines.push(center("NOT PROOF OF PAYMENT"));
  lines.push("=".repeat(w));
  lines.push(`Date: ${data.billDate}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  lines.push("-".repeat(w));

  // Header — columns sum to w=28: name(14)+sp+qty(3)+sp+amt(9)
  lines.push(`${"Item".padEnd(14)} ${"Qty".padStart(3)} ${"Amount".padStart(9)}`);
  lines.push("-".repeat(w));

  let totalSavings = 0;
  for (const item of data.items) {
    const qty = String(item.qty).padStart(3);
    const amt = item.total.toFixed(2).padStart(9);
    if (item.name.length <= 14) {
      // Fits on one line with qty/amt to the right.
      lines.push(`${item.name.padEnd(14)} ${qty} ${amt}`);
    } else {
      // Print full name (wrapping at 28 chars), then qty/amt right-aligned on next line.
      for (let i = 0; i < item.name.length; i += w) {
        lines.push(item.name.substring(i, i + w));
      }
      lines.push(`${" ".repeat(14)} ${qty} ${amt}`);
    }
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
  lines.push(totalLine("AMOUNT DUE", data.total));
  lines.push("=".repeat(w));
  lines.push("");
  lines.push(center("Please pay at the counter"));
  lines.push(center("to complete this order."));
  lines.push(center("A receipt follows payment."));

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
    const indent = " ".repeat(4); // qty(3) + space
    const nameWidth = w - 4;
    if (item.name.length <= nameWidth) {
      lines.push(`${qty} ${item.name}`);
    } else {
      // First line includes qty, subsequent lines indented under name column.
      lines.push(`${qty} ${item.name.substring(0, nameWidth)}`);
      for (let i = nameWidth; i < item.name.length; i += nameWidth) {
        lines.push(`${indent}${item.name.substring(i, i + nameWidth)}`);
      }
    }
  }
  lines.push("=".repeat(w));
  lines.push("");
  return lines.join("\n");
}

/** How a stored payment method reads on paper. 'upi' is stored (it is what the
 *  CHECK constraints and every report key on), but the shop and its customers
 *  know the QR payment as LankaQR. */
function printedMethod(method: string): string {
  const m = String(method || "").toLowerCase();
  if (m === "upi") return "LankaQR";
  if (m === "card") return "Card";
  if (m === "cash") return "Cash";
  return String(method || "-");
}

/**
 * The extra block printed under a pre-order's collection receipt.
 *
 * buildReceiptText() knows nothing about deposits (it describes one bill paid
 * in one go), so the breakdown the customer needs — what the cake cost, what
 * they had already paid, what they handed over today — is appended here. Same
 * width and the same label/value alignment as the receipt it is glued to, so it
 * comes off the thermal printer as one slip.
 *
 * Lives here rather than in the pre-order route because two places print it:
 * the collect response, and GET /api/pos/bills/:id/receipt, so a REPRINT of a
 * collection bill says the same thing as the original slip instead of a bare
 * receipt whose TOTAL the customer never actually handed over.
 */
export function buildPreorderSettlementBlock(args: {
  preOrderId: number | null;
  billTotal: number;
  depositApplied: number;
  cashToCollect: number;
  cashReceived: number | null;
  changeDue: number | null;
}): string | null {
  // Nothing to add when the order was paid in full at the counter like any
  // other sale and no change was worked out: the receipt above already says it
  // all, and a block reading "Paid in Advance -0.00" is noise that invites the
  // customer to ask what it means.
  if (args.depositApplied <= 0.005 && args.cashReceived == null) return null;
  const w = 28;
  const center = (t: string) => " ".repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t;
  const line = (label: string, value: number, neg = false) =>
    `${label.padEnd(17)} ${(neg ? "-" : "") + value.toFixed(2)}`.padEnd(w);

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(w));
  lines.push(center(args.preOrderId != null ? `PRE-ORDER #${args.preOrderId}` : "PRE-ORDER"));
  lines.push("-".repeat(w));
  lines.push(line("Bill Total", args.billTotal));
  if (args.depositApplied > 0.005) {
    lines.push(line("Paid in Advance", args.depositApplied, true));
    lines.push(line("Balance Due Now", args.cashToCollect));
  }
  if (args.cashReceived != null) {
    lines.push(line("Cash Given", args.cashReceived));
    lines.push(line("Change", args.changeDue ?? 0));
  }
  lines.push("=".repeat(w));
  return "\n" + lines.join("\n");
}

export interface DepositSlipData {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  preOrderId: number;
  /** When this payment was taken, already formatted for Colombo. */
  printedAt: string;
  customerName: string;
  customerPhone?: string | null;
  /** Business date, YYYY-MM-DD. */
  collectionDate: string;
  collectionTime?: string | null;
  items: { qty: number; name: string; total: number }[];
  orderTotal: number;
  paymentAmount: number;
  paymentMethod: string;
  totalPaid: number;
  balanceDue: number;
  cashierName?: string | null;
}

/**
 * The slip handed over when a pre-order DEPOSIT or TOP-UP is taken.
 *
 * The customer has just given the shop money for a cake they will not see for
 * days; this is their only proof of it, and what they bring back on collection
 * day. It must say which order, what was ordered, what this payment was, what
 * is paid in total and what is still to pay.
 *
 * It must NOT pass for a sales receipt: no token (no bill exists yet — the sale
 * is rung up on collection, when the real receipt prints), the shop name in
 * text rather than the receipt's logo, and an explicit "not a sales receipt"
 * line. Same 28-column layout as every other slip so the thermal printer
 * output looks like one shop's stationery.
 */
export function buildDepositSlipText(data: DepositSlipData): string {
  const lines: string[] = [];
  const w = 28;
  const center = (text: string) => " ".repeat(Math.max(0, Math.floor((w - text.length) / 2))) + text;
  const totalLine = (label: string, value: number) => `${label.padEnd(17)} ${value.toFixed(2)}`.padEnd(w);
  const wrap = (text: string) => {
    for (let i = 0; i < text.length; i += w) lines.push(text.substring(i, i + w));
  };

  if (data.shopName) lines.push(center(data.shopName));
  if (data.shopAddress) lines.push(center(data.shopAddress));
  if (data.shopPhone) lines.push(center(`Tel: ${data.shopPhone}`));
  lines.push("=".repeat(w));
  lines.push(center("PRE-ORDER DEPOSIT"));
  lines.push("=".repeat(w));
  lines.push(`Order: #${data.preOrderId}`);
  lines.push(`Date: ${data.printedAt}`);
  wrap(`Customer: ${data.customerName}`);
  if (data.customerPhone) lines.push(`Phone: ${data.customerPhone}`);
  // A business date, so it is formatted from its own parts — never through a
  // Date in local time, which could move it to the neighbouring day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.collectionDate || "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let collectOn = data.collectionDate;
  if (m) {
    const [, y = "", mo = "", d = ""] = m;
    const weekday = new Date(Date.UTC(+y, +mo - 1, +d)).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
    collectOn = `${weekday} ${d} ${months[+mo - 1] ?? mo} ${y}`;
  }
  lines.push(`Collect: ${collectOn}`);
  if (data.collectionTime) wrap(`Time: ${data.collectionTime}`);
  lines.push("-".repeat(w));

  // Lines summary: what the deposit is FOR. Qty and description, then the line
  // value right-aligned, wrapping long cake descriptions the way the receipt
  // does (18 + space + 9 = 28).
  for (const item of data.items) {
    const label = `${item.qty} x ${item.name}`;
    const amt = item.total.toFixed(2).padStart(9);
    if (label.length <= 18) {
      lines.push(`${label.padEnd(18)} ${amt}`);
    } else {
      wrap(label);
      lines.push(`${" ".repeat(18)} ${amt}`);
    }
  }
  lines.push("-".repeat(w));
  lines.push(totalLine("Order Total", data.orderTotal));
  lines.push("=".repeat(w));
  lines.push(totalLine("THIS PAYMENT", data.paymentAmount));
  lines.push(`${"Paid by".padEnd(17)} ${printedMethod(data.paymentMethod).padStart(10)}`);
  lines.push("-".repeat(w));
  lines.push(totalLine("Total Paid", data.totalPaid));
  lines.push(totalLine("BALANCE DUE", data.balanceDue));
  lines.push("=".repeat(w));
  if (data.cashierName) wrap(`Taken by: ${data.cashierName}`);
  lines.push("");
  lines.push(center("NOT A SALES RECEIPT"));
  lines.push(center("Please bring this slip"));
  lines.push(center("when you collect."));
  lines.push(center("Your receipt prints then."));

  return lines.join("\n");
}

// Thermal printing via raw ESC/POS commands to a Windows shared printer.
// This is the only part that touches the device, and it can block for seconds
// when the printer is jammed, offline or the share is unreachable — so it is
// kept separate from the (instant, pure) text building above.
// A printer target is a Windows share, a device port, or an explicit absolute
// path. This matters because Bun.write() CREATES missing parent directories: a
// mistyped address (a single leading backslash instead of two, say) is treated
// as a relative path, so every receipt is silently written into a new folder on
// the server while the app reports printing as fine. Refuse anything that is
// not recognisably a printer so the mistake surfaces immediately.
export function isValidPrinterTarget(address: string): boolean {
  const addr = (address || "").trim();
  if (!addr) return false;
  if (/^\\\\[^\\/]+\\[^\\/]/.test(addr)) return true;          // \\server\share
  if (/^(LPT[1-9]|COM[1-9]|PRN):?$/i.test(addr)) return true;  // device port
  if (/^[A-Za-z]:[\\/]/.test(addr)) return true;               // explicit absolute path
  return false;
}

export async function sendToPrinter(text: string): Promise<{ success: boolean; error?: string }> {
  const settings = getSettings();

  if (settings.printer_type === "none") {
    return { success: true, error: "No printer configured - receipt text generated only" };
  }

  // For Windows: use the `net use` printer share or direct USB via printer name
  // We'll generate the text and use a simple file-write approach to the printer port
  try {
    const printerAddress = settings.printer_address || "";
    if (!printerAddress) {
      return { success: false, error: "No printer address configured" };
    }
    if (!isValidPrinterTarget(printerAddress)) {
      return {
        success: false,
        error: `Printer address "${printerAddress}" is not a printer share, device port or absolute path - nothing was printed. Check it on the Settings page.`,
      };
    }

    // ESC/POS: Initialize + text + cut + open cash drawer
    const ESC = "\x1B";
    const GS = "\x1D";
    const init = `${ESC}@`; // Initialize printer
    const cut = `${GS}V\x00`; // Full cut
    const rawData = `${init}${text}\n\n\n${cut}`;

    // Write to printer (Windows shared printer or USB)
    await Bun.write(printerAddress, rawData);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Serial print queue. Callers fire-and-forget, so without this two bills rung up
// back to back would write to the same printer share at once and interleave their
// ESC/POS byte streams. Jobs run strictly one after another; a failed job resolves
// (sendToPrinter never throws) so it can't break the chain for the jobs behind it.
let printQueue: Promise<unknown> = Promise.resolve();

export function queuePrint(text: string): Promise<{ success: boolean; error?: string }> {
  const job = printQueue.then(() => sendToPrinter(text));
  printQueue = job.catch(() => {}); // belt and braces: keep the chain alive
  return job;
}

// Build + print in one step. Kept for callers that want to block on the device.
export async function printReceipt(data: PrintReceiptData): Promise<{ success: boolean; text: string; error?: string }> {
  const text = buildReceiptText(data);
  const result = await queuePrint(text);
  return { ...result, text };
}
