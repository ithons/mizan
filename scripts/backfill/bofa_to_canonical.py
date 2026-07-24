#!/usr/bin/env python3
"""Convert Bank of America card exports into one canonical backfill CSV.

Two sources, partitioned by date so they never overlap:
  - Year-end summary PDFs: a full itemized SPEND list per year (no payments/interest).
    Used only for dates BEFORE the earliest monthly CSV.
  - Monthly CSV exports (Posted Date/Reference Number/Payee/Address/Amount): the recent
    window, and the authority wherever it reaches (it also carries payments/refunds).

Emits data/backfill/raw/<slug>.csv in the canonical shape (account_name,date,amount,
merchant,category,notes). Sign convention: negative = outflow (purchase), positive =
inflow (payment/refund). Floor filtering happens later in normalize.ts, not here.

Self-check: each PDF's parsed spend total is reconciled against its printed "Annual total".

Requires pypdf (the repo has no Node PDF dep; this one-off prep runs in a venv).
"""
import csv, glob, os, re, sys
from datetime import date

BOFA_DIR = os.path.join(os.getcwd(), "data", "bofa")
OUT_DIR = os.path.join(os.getcwd(), "data", "backfill", "raw")
ACCOUNT_NAME = "Customized Cash Rewards Visa Signature- 2448 (2448)"
OUT_SLUG = "bofa-card"

# Row inside a year-end summary itemized section: MM/DD/YY glued to the description,
# then location, then the amount (optionally suffixed CR for a credit/refund).
PDF_ROW = re.compile(r'(\d{2}/\d{2}/\d{2})\s*(.*?)\s+(\d[\d,]*\.\d{2})(CR)?')


def parse_pdf(path):
    from pypdf import PdfReader
    text = "".join(p.extract_text() for p in PdfReader(path).pages)
    coverage = re.search(r'between\s+(January 1, \d{4}) and (December 31, \d{4})', text)
    # Only the "Preparing your taxes" section is the itemized ledger; before it are the
    # category/monthly summary tables (also full of $ amounts we must not ingest).
    body = text.split("Preparing your taxes", 1)
    body = body[1] if len(body) > 1 else text
    rows, spent = [], 0.0
    for m in PDF_ROW.finditer(body):
        mm, dd, yy = m.group(1).split("/")
        iso = f"20{yy}-{mm}-{dd}"
        val = float(m.group(3).replace(",", ""))
        is_credit = m.group(4) == "CR"
        rows.append((iso, val if is_credit else -val, m.group(2).strip()))
        spent += -val if is_credit else val
    # The "Annual total" line lists a per-category subtotal for each column and ends with
    # the grand total; take the LAST amount before the page break, not the first column.
    line = re.search(r'Annual total(.*?)Page', text, re.S)
    printed = re.findall(r'([\d,]+\.\d{2})', line.group(1)) if line else []
    return rows, coverage.group(0) if coverage else "??", spent, \
        float(printed[-1].replace(",", "")) if printed else None


def parse_csv(path):
    rows = []
    with open(path) as fh:
        for r in csv.DictReader(fh):
            mm, dd, yy = r["Posted Date"].split("/")
            rows.append((f"{yy}-{int(mm):02d}-{int(dd):02d}",
                         float(r["Amount"]), r["Payee"].strip()))
    return rows


def main():
    csv_files = sorted(glob.glob(os.path.join(BOFA_DIR, "*_2448.csv")))
    pdf_files = sorted(glob.glob(os.path.join(BOFA_DIR, "YearEndSummary_*.pdf")))

    csv_rows = [row for f in csv_files for row in parse_csv(f)]
    csv_min = min(r[0] for r in csv_rows)
    print(f"Monthly CSVs: {len(csv_files)} files, {len(csv_rows)} rows, earliest {csv_min}")

    # PDFs only contribute dates the CSVs don't cover -> clean partition at csv_min.
    pdf_rows = []
    for f in pdf_files:
        rows, cov, spent, printed = parse_pdf(f)
        ok = "OK" if printed and abs(spent - printed) < 0.02 else f"MISMATCH (printed {printed})"
        print(f"  {os.path.basename(f)}: {len(rows)} rows, covers {cov}, "
              f"parsed spend ${spent:,.2f} vs annual ${printed:,.2f} -> {ok}"
              if printed else f"  {os.path.basename(f)}: {len(rows)} rows, covers {cov}")
        pdf_rows.extend(r for r in rows if r[0] < csv_min)
    print(f"PDF rows kept (date < {csv_min}): {len(pdf_rows)}")

    combined = sorted(pdf_rows + csv_rows, key=lambda r: r[0])
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{OUT_SLUG}.csv")
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["account_name", "date", "amount", "merchant", "category", "notes"])
        for iso, amt, merchant in combined:
            w.writerow([ACCOUNT_NAME, iso, f"{amt:.2f}", merchant, "", ""])
    print(f"\nWrote {out}: {len(combined)} rows, {combined[0][0]} .. {combined[-1][0]}")


if __name__ == "__main__":
    main()
