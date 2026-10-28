// Core catalog CSV import (2026-10-27).
// Builds a validated, deterministic import plan from uploaded CSV rows.
// Rules (owner decisions):
//  - Match on product_code (case-insensitive). If a row has no code, match on exact name.
//    If a code is given but unknown, fall back to an exact-name match only when that
//    product has no code yet (prevents duplicate products).
//  - Unmatched rows create new products.
//  - The CSV is the full catalog: products currently selling that no row matches are
//    taken off sale (never deleted). Archived products are left alone.
//  - Blank cells leave the existing value unchanged.
//  - Any error blocks the whole import.

export const TEMPLATE_COLUMNS = [
  "product_code", "name", "price", "category", "product_type", "ships_from",
  "available", "featured", "hide_from_resident_new", "description", "image_url",
  "sku", "research_name", "purity", "quantity", "lot_number", "coa_url",
] as const;

const HEADER_ALIASES: Record<string, string> = {
  code: "product_code", product: "name", product_name: "name", shipping_from: "ships_from",
  shipping: "ships_from", selling: "available", selling_on_nexus: "available",
  hidden: "hide_from_resident_new", core_hidden: "hide_from_resident_new", image: "image_url",
  coa: "coa_url", lot: "lot_number", type: "product_type",
};

export type Product = {
  id: string; name: string; product_code: string | null; sku: string | null;
  research_name: string | null; category_id: string | null; description: string | null;
  purity: string | null; quantity: string | null; lot_number: string | null;
  coa_url: string | null; image_url: string | null; product_type: string | null;
  shipping_from: string | null; active: boolean; storefront_status: string | null;
  featured: boolean; core_hidden: boolean; price: number | string; updated_at: string;
};
export type Category = { id: string; name: string };

type Change = { field: string; from: unknown; to: unknown };
type Issue = { row: number; message: string };

export type ImportPlan = {
  creates: Array<{ row: number; fields: Record<string, unknown> }>;
  updates: Array<{ row: number; id: string; expected_updated_at: string; patch: Record<string, unknown> }>;
  takeoffs: Array<{ id: string; expected_updated_at: string }>;
};

export type ImportPreview = {
  plan: ImportPlan;
  summary: { rows: number; create: number; update: number; unchanged: number; takeOffSale: number; errors: number; currentlySelling: number };
  creates: Array<{ row: number; name: string; product_code: string | null; price: number; available: boolean }>;
  updates: Array<{ row: number; name: string; product_code: string | null; matchedBy: "code" | "name"; changes: Change[] }>;
  takeoffs: Array<{ name: string; product_code: string | null }>;
  errors: Issue[];
  warnings: string[];
};

const norm = (value: string) => value.trim().toLowerCase();
const normHeader = (value: string) => {
  const key = value.replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return HEADER_ALIASES[key] || key;
};

function parseBool(raw: string): boolean | null {
  const v = norm(raw);
  if (["yes", "y", "true", "1", "x"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return null;
}

function parseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol) ? raw : null;
  } catch {
    return null;
  }
}

const isSelling = (p: Product) => p.active && norm(String(p.storefront_status || "")) === "available";
const isArchived = (p: Product) => norm(String(p.storefront_status || "")) === "archived";

export function buildImportPlan(
  rawRows: Array<Record<string, unknown>>,
  products: Product[],
  categories: Category[],
  shippingRates: Record<string, number>,
): ImportPreview {
  const errors: Issue[] = [];
  const warnings: string[] = [];
  const plan: ImportPlan = { creates: [], updates: [], takeoffs: [] };
  const creates: ImportPreview["creates"] = [];
  const updates: ImportPreview["updates"] = [];
  let unchanged = 0;

  const byCode = new Map<string, Product[]>();
  const byName = new Map<string, Product[]>();
  for (const p of products) {
    if (p.product_code?.trim()) {
      const k = norm(p.product_code);
      byCode.set(k, [...(byCode.get(k) || []), p]);
    }
    const n = norm(p.name);
    byName.set(n, [...(byName.get(n) || []), p]);
  }
  const categoryByName = new Map(categories.map(c => [norm(c.name), c.id]));
  const rateSources = new Map(Object.keys(shippingRates).map(s => [norm(s), s]));

  // Normalize headers once.
  const rows = rawRows.map(r => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) out[normHeader(k)] = String(v ?? "").trim();
    return out;
  });
  if (rows.length) {
    const headers = new Set(Object.keys(rows[0]));
    if (!headers.has("name") && !headers.has("product_code")) {
      errors.push({ row: 1, message: "The CSV needs a “name” or “product_code” column. Download the template for the exact columns." });
    }
    const unknown = [...headers].filter(h => h && !(TEMPLATE_COLUMNS as readonly string[]).includes(h));
    if (unknown.length) warnings.push("Ignored unknown column(s): " + unknown.join(", "));
  }

  const matchedIds = new Map<string, number>();
  const newKeys = new Map<string, number>();

  rows.forEach((r, index) => {
    const row = index + 2; // header is row 1
    const has = (k: string) => (r[k] ?? "") !== "";
    if (!Object.values(r).some(v => v !== "")) return; // skip blank lines
    const rowErrors: string[] = [];

    // ---- parse fields present in this row (blank = leave unchanged) ----
    const fields: Record<string, unknown> = {};
    let available: boolean | null = null;

    if (has("name")) {
      if (r.name.length > 200) rowErrors.push("name is longer than 200 characters");
      fields.name = r.name;
    }
    if (has("price")) {
      const text = r.price.replace(/^\$/, "").replace(/,/g, "");
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(text) || Number(text) > 100000) rowErrors.push(`price “${r.price}” must look like 49 or 49.99`);
      else fields.price = Math.round(Number(text) * 100) / 100;
    }
    for (const [col, max] of [["product_code", 120], ["sku", 120], ["research_name", 200], ["product_type", 120],
      ["purity", 120], ["quantity", 120], ["lot_number", 120], ["description", 5000]] as const) {
      if (has(col)) {
        if (r[col].length > max) rowErrors.push(`${col} is longer than ${max} characters`);
        fields[col] = r[col];
      }
    }
    if (has("category")) {
      const id = categoryByName.get(norm(r.category));
      if (!id) rowErrors.push(`unknown category “${r.category}” (use one of: ${categories.map(c => c.name).join(", ")})`);
      else fields.category_id = id;
    }
    if (has("ships_from")) {
      const source = rateSources.get(norm(r.ships_from));
      if (!source) rowErrors.push(`unknown ships_from “${r.ships_from}”. Add it under Shipping rates first`);
      else fields.shipping_from = source;
    }
    for (const col of ["image_url", "coa_url"] as const) {
      if (has(col)) {
        if (!parseUrl(r[col])) rowErrors.push(`${col} must be a valid http(s) URL`);
        else fields[col] = r[col];
      }
    }
    for (const [col, key] of [["featured", "featured"], ["hide_from_resident_new", "core_hidden"]] as const) {
      if (has(col)) {
        const b = parseBool(r[col]);
        if (b === null) rowErrors.push(`${col} must be yes or no`);
        else fields[key] = b;
      }
    }
    if (has("available")) {
      available = parseBool(r.available);
      if (available === null) rowErrors.push("available must be yes or no");
    }

    // ---- match ----
    let match: Product | null = null;
    let matchedBy: "code" | "name" = "code";
    const code = has("product_code") ? norm(r.product_code) : "";
    const name = has("name") ? norm(r.name) : "";
    if (code) {
      const hits = byCode.get(code) || [];
      if (hits.length > 1) rowErrors.push(`product_code “${r.product_code}” matches ${hits.length} products in Core; fix the duplicates first`);
      else if (hits.length === 1) match = hits[0];
      else if (name) {
        const named = (byName.get(name) || []).filter(p => !p.product_code?.trim());
        if (named.length === 1) { match = named[0]; matchedBy = "name"; }
      }
    } else if (name) {
      const hits = byName.get(name) || [];
      if (hits.length > 1) rowErrors.push(`name “${r.name}” matches ${hits.length} products; add a product_code to pick one`);
      else if (hits.length === 1) { match = hits[0]; matchedBy = "name"; }
    } else {
      rowErrors.push("row has neither a product_code nor a name");
    }

    if (match) {
      const first = matchedIds.get(match.id);
      if (first) rowErrors.push(`matches the same product as row ${first} (“${match.name}”)`);
      else matchedIds.set(match.id, row);
    } else if (!rowErrors.length) {
      const key = code || name;
      const first = newKeys.get(key);
      if (first) rowErrors.push(`duplicates new product in row ${first}`);
      else newKeys.set(key, row);
      if (!has("name")) rowErrors.push("new products need a name");
      if (!has("price")) rowErrors.push("new products need a price");
    }

    if (rowErrors.length) {
      for (const message of rowErrors) errors.push({ row, message });
      return;
    }

    if (!match) {
      const selling = available === true;
      plan.creates.push({ row, fields: { ...fields, active: selling, storefront_status: selling ? "Available" : "Inactive" } });
      creates.push({ row, name: String(fields.name), product_code: (fields.product_code as string) || null, price: Number(fields.price), available: selling });
      return;
    }

    // ---- diff against the existing product ----
    const patch: Record<string, unknown> = {};
    const changes: Change[] = [];
    const current = match as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      const before = key === "price" ? Number(current.price) : (current[key] ?? null);
      // Match keys: a case-only difference is not a change (keeps the catalog's casing).
      const same = key === "product_code" || key === "name"
        ? norm(String(before ?? "")) === norm(String(value ?? ""))
        : before === value || String(before ?? "") === String(value ?? "");
      if (!same) { patch[key] = value; changes.push({ field: key, from: before, to: value }); }
    }
    if (available !== null) {
      const sellingNow = isSelling(match);
      if (available && !sellingNow) {
        patch.active = true; patch.storefront_status = "Available";
        changes.push({ field: "available", from: isArchived(match) ? "archived" : "no", to: "yes" });
      } else if (!available && sellingNow) {
        patch.active = false; patch.storefront_status = "Inactive";
        changes.push({ field: "available", from: "yes", to: "no" });
      }
    }
    if (!changes.length) { unchanged += 1; return; }
    plan.updates.push({ row, id: match.id, expected_updated_at: match.updated_at, patch });
    updates.push({ row, name: match.name, product_code: match.product_code, matchedBy, changes });
  });

  // ---- products selling now that the CSV doesn't mention ----
  const currentlySelling = products.filter(p => p.active);
  const takeoffs = currentlySelling.filter(p => !matchedIds.has(p.id) && !isArchived(p))
    .sort((a, b) => a.name.localeCompare(b.name));
  plan.takeoffs = takeoffs.map(p => ({ id: p.id, expected_updated_at: p.updated_at }));
  if (currentlySelling.length && takeoffs.length / currentlySelling.length > 0.5) {
    warnings.push(`This file would take ${takeoffs.length} of ${currentlySelling.length} selling products off sale. Make sure it contains your whole catalog.`);
  }

  plan.creates.sort((a, b) => a.row - b.row);
  plan.updates.sort((a, b) => a.row - b.row);

  return {
    plan,
    summary: {
      rows: rows.filter(r => Object.values(r).some(v => v !== "")).length,
      create: plan.creates.length, update: plan.updates.length, unchanged,
      takeOffSale: plan.takeoffs.length, errors: errors.length, currentlySelling: currentlySelling.length,
    },
    creates, updates,
    takeoffs: takeoffs.map(p => ({ name: p.name, product_code: p.product_code })),
    errors, warnings,
  };
}

export async function planHash(plan: ImportPlan): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
