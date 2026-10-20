#!/usr/bin/env python3
"""Parse Bank of America credit card statement PDFs (eStmt_YYYY-MM-DD.pdf) into one reviewed JSON.

Input: data/bofa/statements/*.pdf (text PDFs; needs pdftotext from poppler).
Output: data/backfill/raw/bofa-card-statements.json, written only when every statement passes:
each section's rows sum to its printed total, the summary adds up (previous balance + credits +
purchases + fees + interest = new balance), and each previous balance equals the prior statement's
new balance unless a statement is missing between them, which is reported.

Amounts are cents in the ledger's convention for a card: a purchase is negative, a payment or
credit positive. Rows carry the posting date, which is the date the ledger uses for this card.

  python3 scripts/backfill/bofa_card_statements.py
"""
import glob, json, os, re, subprocess, sys
from datetime import date

SRC = os.path.join(os.getcwd(), 'data', 'bofa', 'statements')
OUT = os.path.join(os.getcwd(), 'data', 'backfill', 'raw', 'bofa-card-statements.json')
MONTHS = {m: i + 1 for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july',
                                          'august', 'september', 'october', 'november', 'december'])}
PERIOD = re.compile(r'([A-Z][a-z]+) (\d{1,2}) - ([A-Z][a-z]+) (\d{1,2}), (\d{4})')
MONEY = r'(-?\$?[\d,]+\.\d{2})'
SUMMARY = {
    'previous': re.compile(r'^\s*Previous Balance\s+' + MONEY),
    'credits': re.compile(r'^\s*Payments and Other Credits\s+' + MONEY),
    'purchases': re.compile(r'^\s*Purchases and Adjustments\s+' + MONEY),
    'fees': re.compile(r'^\s*Fees Charged\s+' + MONEY),
    'interest': re.compile(r'^\s*Interest Charged\s+' + MONEY),
    'new': re.compile(r'New Balance Total\s+' + MONEY + r'\s*$'),
}
SECTIONS = {'Payments and Other Credits': 'credits', 'Purchases and Adjustments': 'purchases',
            'Fees Charged': 'fees', 'Fees': 'fees', 'Interest Charged': 'interest'}
TOTAL = re.compile(r'TOTAL (PAYMENTS AND OTHER CREDITS|PURCHASES AND ADJUSTMENTS|FEES CHARGED|FEES|INTEREST CHARGED) FOR THIS PERIOD\s+' + MONEY)
TOTAL_KEY = {'PAYMENTS AND OTHER CREDITS': 'credits', 'PURCHASES AND ADJUSTMENTS': 'purchases',
             'FEES CHARGED': 'fees', 'FEES': 'fees', 'INTEREST CHARGED': 'interest'}
ROW = re.compile(r'^\s*(\d\d)/(\d\d)\s+(\d\d)/(\d\d)\s+(.*?)\s{2,}(?:(\d{4})\s+(\d{4})\s+)?' + MONEY + r'\s*$')


def cents(s):
    v = int(re.sub(r'[^\d]', '', s))
    return -v if '-' in s else v


def dated(month, day, close):
    year = close.year - 1 if int(month) > close.month else close.year
    return date(year, int(month), int(day)).isoformat()


def parse(path):
    text = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True, check=True).stdout
    p = PERIOD.search(text)
    close = date(int(p[5]), MONTHS[p[3].lower()], int(p[4]))
    start = date(close.year - (1 if MONTHS[p[1].lower()] > close.month else 0), MONTHS[p[1].lower()], int(p[2]))
    st = {'file': os.path.basename(path), 'start': start.isoformat(), 'close': close.isoformat(),
          'summary': {}, 'totals': {}, 'rows': []}
    for key, pattern in [('credit_line', r'Total Credit Line\s+' + MONEY), ('due_date', r'Payment Due Date\s+(\d\d/\d\d/\d{4})'),
                         ('minimum_due', r'Total Minimum Payment Due\s+' + MONEY), ('purchase_apr', r'Purchases\s+([\d.]+)%')]:
        m = re.search(pattern, text)
        if m:
            st[key] = cents(m[1]) if key in ('credit_line', 'minimum_due') else m[1]
    section = None
    for line in text.splitlines():
        for k, rx in SUMMARY.items():
            m = rx.search(line)
            if m and k not in st['summary']:
                st['summary'][k] = cents(m[1])
        head = line.strip()
        if head in SECTIONS:
            section = SECTIONS[head]
            continue
        m = TOTAL.search(line)
        if m:
            st['totals'][TOTAL_KEY[m[1]]] = cents(m[2])
            section = None
            continue
        m = ROW.match(line)
        if m and section:
            st['rows'].append({
                'section': section, 'transaction_date': dated(m[1], m[2], close), 'date': dated(m[3], m[4], close),
                'desc': re.sub(r'\s{2,}', ' ', m[5]).strip(), 'reference': m[6], 'cents': -cents(m[8]),
            })
    st['rows'] = [r for r in st['rows'] if r['cents'] != 0]
    return st


def problems(st, prev):
    out = []
    s = st['summary']
    if len(s) != 6:
        out.append(f'summary lines found: {sorted(s)}')
        return out
    for k in ('credits', 'purchases', 'fees', 'interest'):
        got = -sum(r['cents'] for r in st['rows'] if r['section'] == k)
        if got != s[k]:
            out.append(f'{k}: rows {got} vs summary {s[k]}')
        if k in st['totals'] and st['totals'][k] != s[k]:
            out.append(f'{k}: section total {st["totals"][k]} vs summary {s[k]}')
    if s['previous'] + s['credits'] + s['purchases'] + s['fees'] + s['interest'] != s['new']:
        out.append('summary does not add up')
    if prev and prev['summary'].get('new') != s['previous']:
        out.append(f'previous balance {s["previous"]} vs prior new balance {prev["summary"].get("new")}')
    for r in st['rows']:
        if not st['start'] <= r['date'] <= st['close']:
            out.append(f'{r["date"]} outside period: {r["desc"]}')
    return out


def main():
    statements = [parse(p) for p in sorted(glob.glob(os.path.join(SRC, 'eStmt_*.pdf')))]
    failed = False
    for i, st in enumerate(statements):
        prev = statements[i - 1] if i else None
        gap = prev and date.fromisoformat(st['start']).toordinal() - date.fromisoformat(prev['close']).toordinal() != 1
        issues = problems(st, None if gap else prev)
        if gap:
            st['missing_before'] = f"no statement for {prev['close']} to {st['start']}"
        print(f"{st['start']}..{st['close']} {len(st['rows']):3} rows new {st['summary'].get('new')}  "
              f"{'OK' if not issues else issues}{'  (' + st['missing_before'] + ')' if gap else ''}")
        failed |= bool(issues)
    if failed:
        sys.exit('Not written.')
    with open(OUT, 'w') as fh:
        json.dump(statements, fh, indent=1)
    print(f'Wrote {sum(len(s["rows"]) for s in statements)} rows from {len(statements)} statements.')


if __name__ == '__main__':
    main()
