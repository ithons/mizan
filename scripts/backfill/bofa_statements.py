#!/usr/bin/env python3
"""Parse scanned Bank of America checking and savings statements into one reviewed JSON.

Input, all gitignored under data/backfill/raw/bofa-statements/:
  checking/p-NNN.txt, savings/p-NNN.txt   tesseract text of each scanned page (--ocr makes them)
  fixes.json                              [page, ocr text, corrected text, how it was verified]
  local.json                              {"owner": name as printed, "repairs": [[regex, replacement]],
                                           "merchants": [[regex, merchant, category id or null]]}

Output: data/backfill/raw/bofa-statements/statements.json, written only when every statement
passes: each section's rows sum to the printed summary and to the printed section total, the
summary adds up, each beginning balance equals the previous ending balance, every row date lies
inside its statement period, and rows within a section are in date order. A scan misread that
survives all of that would have to cancel exactly within one section.

  python3 scripts/backfill/bofa_statements.py --ocr "<checking pdf>" "<savings pdf>"
  python3 scripts/backfill/bofa_statements.py
"""
import glob, json, os, re, subprocess, sys
from datetime import date

ROOT = os.path.join(os.getcwd(), 'data', 'backfill', 'raw', 'bofa-statements')
MONTHS = {m: i + 1 for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july',
                                          'august', 'september', 'october', 'november', 'december'])}
PERIOD = re.compile(r'for\s+([A-Za-z]+)\s+(\d+),\s*(\d{4})\s+to\s+([A-Za-z]+)\s+(\d+),\s*(\d{4})')
AMT = r'[-~—–“"\']?\s?\$?§?\d[\d,]*[.,]\d{2}'
ROW = re.compile(r'^(\d{2})/(\d{2})/(\d{2})[.,]?\s+(.*?)\s+(' + AMT + r')[-:.°)\'’\s]*(?:\S{1,3})?\s*$')
DATE_ONLY = re.compile(r'^(\d{2})/(\d{2})/(\d{2})\s+(.*)$')
SECTIONS = [(key, re.compile(rf'^{title}(\s*-\s*continued)?\s*$', re.I)) for key, title in [
    ('deposits', 'Deposits and other additions'), ('atm', 'ATM and debit card subtractions'),
    ('other', 'Other subtractions'), ('fees', 'Service fees')]]
TOTAL = re.compile(r'^Tota[l!] (deposits and other additions|ATM and debit card subtractions|other subtractions|service fees)'
                   r'\s*[-~—–]?\s*\$?§?([\d,]+\.\d{2})', re.I)
TOTAL_KEY = {'deposits and other additions': 'deposits', 'atm and debit card subtractions': 'atm',
             'other subtractions': 'other', 'service fees': 'fees'}
SUMMARY = {
    'begin': re.compile(r'Beginning ba.ance on .*?\$?([-\d,]+\.\d{2})'),
    'deposits': re.compile(r'^Deposits and other additions\s+([-\d,]+[.,]\d{2})'),
    'atm': re.compile(r'^ATM and debit card subtractions\s*[:.]?\s+[-~—]?\s?([\d,]+[.,]\d{2})'),
    'other': re.compile(r'^Other subtractions\s*[:.]?\s+[-~—]?\s?([\d,]+[.,]\d{2})'),
    'fees': re.compile(r'^Service fees\s*[:.]?\s+[-~—]?\s?([\d,]+[.,]\d{2})'),
    'end': re.compile(r'Ending balance on .*?\$?([-\d,]+\.\d{2})'),
}
NOISE = re.compile(r'^(Page \d+|Date (Transaction )?Description|Total |Braille|bankofamerica|.*\| ?Account #|BANK OF AMERICA|'
                   r'Continued|continued|Withdrawals and other|Note your|Thank you|.*intentionally left blank|\$SM-|SSM-)', re.I)
OCR_REPAIRS = [
    (r'[—–§]', ' '), (r'\s+\$?[S5$]{1,2}M-\d\d-\d\d-.*$', ''),
    (r' for [“"\'*‘]?(.*?)[”"’\'*]?[;,]? Conf#? ?(\S+)$', r' for "\1"; Conf# \2'), (r'(?<=\s)‘(?=\w)', ''),
    (r'(?<=\s)(?:[1(\[{t#iI]|I1)D[:;]', 'ID:'), (r'[!{]NDN', 'INDN'), (r'1\[D:', 'ID:'), (r'(?<=\s)10:(?=\d)', 'ID:'), (r'INDN;:', 'INDN:'),
     (r'Conf[éeé]#?', 'Conf#'), (r'\btnterest\b|^interest\b', 'Interest'), (r'\bZeile\b', 'Zelle'),
    (r'\bfram\b', 'from'), (r'\s+Tota\S*$', ''), (r'^[—–-]+', ''), (r'\s{2,}', ' '),
]


def cents(s):
    s = s.strip()
    assert re.search(r'[.,]\d{2}$', s), s
    v = int(re.sub(r'[^\d]', '', s))
    return -v if s[:1] in '-~—–' else v


def parse_period(text):
    m = PERIOD.search(text)
    if not m:
        return None
    a = date(int(m[3]), MONTHS[m[1].lower()], int(m[2]))
    b = date(int(m[6]), MONTHS[m[4].lower()], int(m[5]))
    return a.isoformat(), b.isoformat()


LOCAL = {'owner': '', 'repairs': [], 'merchants': []}


def clean(desc):
    for pattern, repl in [*OCR_REPAIRS, *LOCAL['repairs']]:
        desc = re.sub(pattern, repl, desc)
    return desc.strip()


def parse_folder(folder, fixes):
    statements, cur = [], None
    for path in sorted(glob.glob(os.path.join(ROOT, folder, 'p-*.txt'))):
        rel = f'{folder}/{os.path.basename(path)}'
        text = open(path).read()
        for page, old, new, _how in fixes:
            if page == rel:
                assert old in text, (rel, old)
                text = text.replace(old, new)
        lines = [l.strip() for l in text.splitlines()]
        if 'Account summary' in text and parse_period(text):
            start, end = parse_period(text)
            head = text.split('Account summary')[0]
            product = re.search(r'Your (.*?)\n', head)
            number = re.search(r'Account number:\s*([\d ]{12,})', head)
            cur = {'folder': folder, 'start': start, 'end': end, 'pages': [], 'summary': {}, 'totals': {}, 'rows': [],
                   'unparsed': [], 'product': product[1].strip() if product else None,
                   'number': re.sub(r'\D', '', number[1]) if number else None}
            for l in lines:
                for k, rx in SUMMARY.items():
                    mm = rx.search(l)
                    if mm and k not in cur['summary']:
                        cur['summary'][k] = cents(mm[1]) if k in ('begin', 'end', 'deposits') else -abs(cents(mm[1]))
                mm = re.search(r'Annual Percentage Yield Earned this statement period:\s*([\d.]+)%', l)
                if mm:
                    cur['apy_earned'] = mm[1].rstrip('.')
                mm = re.search(r'Interest Paid Year To Date:\s*\$([\d,.]+\d)', l, re.I)
                if mm:
                    cur['interest_ytd'] = mm[1]
            addr = re.search(r'\n([^\n]*?)\s*[;.,7]?\s*(?:bankofamerica\.com)?\s*\n([A-Z][A-Z ]+, [A-Z]{2}\s+\d{5}-\d{4})', text)
            if addr:
                cur['mailing_address'] = f"{re.sub(r'[^A-Z0-9 ]', '', addr[1]).strip()}, {addr[2].strip()}"
            statements.append(cur)
        if cur is None:
            continue
        cur['pages'].append(rel)
        section, last = None, None
        for l in lines:
            for k, rx in SECTIONS:
                if rx.match(l):
                    section, last = k, None
            mt = TOTAL.match(l)
            if mt:
                key = TOTAL_KEY[mt[1].lower()]
                cur['totals'][key] = cents(mt[2]) * (1 if key == 'deposits' else -1)
                section, last = None, None
                continue
            if section is None or not l:
                continue
            mr = ROW.match(l)
            if mr:
                amount = abs(cents(mr[5])) * (1 if section == 'deposits' else -1)
                last = {'date': f'20{mr[3]}-{mr[1]}-{mr[2]}', 'desc': mr[4].strip(), 'cents': amount,
                        'section': section, 'page': rel}
                cur['rows'].append(last)
            elif DATE_ONLY.match(l):
                cur['unparsed'].append((rel, l))
                last = None
            elif last and not NOISE.match(l):
                last['desc'] += ' ' + l
    return statements


def problems(st, prev_end):
    out = []
    s = st['summary']
    for k in ('deposits', 'atm', 'other', 'fees'):
        got = sum(r['cents'] for r in st['rows'] if r['section'] == k)
        if s.get(k) is None:
            out.append(f'no summary line for {k}')
        elif got != s[k]:
            out.append(f'{k}: rows {got} vs summary {s[k]}')
        if k in st['totals'] and s.get(k) is not None and st['totals'][k] != s[k]:
            out.append(f'{k}: section total {st["totals"][k]} vs summary {s[k]}')
    if len(s) == 6 and s['begin'] + s['deposits'] + s['atm'] + s['other'] + s['fees'] != s['end']:
        out.append('summary does not add up')
    if prev_end is not None and prev_end != s.get('begin'):
        out.append(f'begins at {s.get("begin")}, previous statement ended at {prev_end}')
    last_by_section = {}
    for r in st['rows']:
        try:
            date.fromisoformat(r['date'])
        except ValueError:
            out.append(f'{r["date"]} is not a date: {r["desc"][:50]}')
            continue
        if not st['start'] <= r['date'] <= st['end']:
            out.append(f'{r["date"]} outside the period: {r["desc"][:50]}')
        if r['date'] < last_by_section.get(r['section'], ''):
            out.append(f'{r["date"]} out of order: {r["desc"][:50]}')
        last_by_section[r['section']] = r['date']
    out += [f'unparsed {page}: {line}' for page, line in st['unparsed']]
    return out


def title(s):
    return ' '.join(w.capitalize() if w.isupper() and len(w) > 2 else w for w in s.split())


CARD_MERCHANTS = [
    (r'^AMZN|^AMAZON', 'Amazon'), (r'UBER .?EATS', 'Uber Eats'), (r'^TARGET', 'Target'), (r'^STAR MARKET', 'Star Market'),
    (r'^BLUEBIKES', 'Bluebikes'), (r'^CSC ServiceWorks', 'CSC ServiceWorks'),
]


def classify(desc, cents_):
    """(merchant, category_id or None). Only structural identifications get a category."""
    d = desc
    m = re.match(r'Zelle payment (to|from) (.*?)(?: for .*)? Conf#? ?\S+(?: \S{1,4})?$', d)
    if m:
        who = title(m[2].strip())
        if LOCAL['owner'] and who.upper().startswith(' '.join(LOCAL['owner'].upper().split()[:2])):
            return 'Zelle to Chase Checking', 'cat_xfer_out'
        return f'Zelle {m[1]} {who}', None
    rules = [
        (r'Online Banking transfer (to|from) (SAV|CHK) \d{4}', lambda m: (f'Transfer {m[1]} BofA {"Savings" if m[2] == "SAV" else "Checking"}', 'cat_xfer_out' if cents_ < 0 else 'cat_xfer_in')),
        (r'MA TLR transfer', lambda m: ('Transfer to BofA Savings' if cents_ < 0 else 'Transfer from BofA Checking', 'cat_xfer_out' if cents_ < 0 else 'cat_xfer_in')),
        (r'(Online (Banking|scheduled) payment to CRD 2448|BANK OF AMERICA CREDIT CARD Bill Payment)', lambda m: ('BofA Cash Rewards payment', 'cat_xfer_cc')),
        (r'^DISCOVER\b', lambda m: ('Discover Credit Card', 'cat_xfer_cc')),
        (r'^CAPITAL ONE\b', lambda m: ('Capital One payment', 'cat_xfer_cc')),
        (r'(?i)^MASS INST\b.*(PAYROLL|DIRECT DEP)', lambda m: ('Mass Inst Payroll', 'cat_income_paycheck')),
        (r'^Interest Earned', lambda m: ('BofA Savings interest', 'cat_income_interest')),
        (r'CASHREWARD', lambda m: ('BofA Cash Rewards redemption', 'cat_income_other')),
        (r'^Federal Withholding', lambda m: ('Federal backup withholding', 'cat_taxes')),
        (r'IRS TREAS 310.*TAX REF', lambda m: ('IRS tax refund', 'cat_taxes')),
        (r'US TREAS TAX PYMT', lambda m: ('US Treasury tax payment', 'cat_taxes')),
        (r'SERVICE FEE 888-658-5465', lambda m: ('Tax payment card fee', 'cat_fees')),
        (r'(Wire Transfer Fee|WITHDRWL .* FEE$|\bFEE$)', lambda m: ('Bank fee', 'cat_fees')),
        (r'^VENMO\b.*CASHOUT', lambda m: ('Transfer from Venmo', 'cat_xfer_in')),
        (r'^VENMO\b.*PAYMENT', lambda m: ('Transfer to Venmo', 'cat_xfer_out')),
        (r'^PAYPAL\b.*TRANSFER', lambda m: ('Transfer from PayPal', 'cat_xfer_in')),
        (r'^COINBASE INC', lambda m: ('Coinbase', 'cat_xfer_out' if cents_ < 0 else 'cat_xfer_in')),
        (r'PMNT SENT \d{4} Coinbase', lambda m: ('Coinbase', 'cat_xfer_out')),
        (r'^FID BKG SVC LLC', lambda m: ('Fidelity Brokerage Services', 'cat_inv_transfer')),
        (r'^Wealthfront\b', lambda m: ('Wealthfront Deposit', 'cat_xfer_out')),
        (r'^MA INSTITUTE TEC\b.*EREFUND', lambda m: ('MIT student account refund', None)),
        (r'^MASS\. INST\. OF T\b', lambda m: ('MIT reimbursement', None)),
        (r'^MA INSTITUTE TEC\b', lambda m: ('MIT payment', None)),
        (r'WIRE IN .*ORIG:(.*?) ID:', lambda m: (f'Wire from {m[1].strip().rstrip(",")}', None)),
        (r'^TRANSFER [^:]+:(.*?) Confirmation', lambda m: (f'Wire to {m[1].strip()}', None)),
        (r'BKOFAMERICA ATM .*WITHDRWL', lambda m: ('ATM withdrawal', None)),
        (r'^\d{10,} \d{2}/\d{2} .*WITHDRWL', lambda m: ('ATM withdrawal', None)),
        (r'^BANK OF AMERICA DES:PAYMENT', lambda m: ('Bank of America payment', None)),
        (r'BKOFAMERICA BC .*WITHDRWL', lambda m: ('Banking center withdrawal', None)),
        (r'BKOFAMERICA MOBILE .*DEPOSIT', lambda m: ('Mobile check deposit', None)),
        (r'BKOFAMERICA ATM .*DEPOSIT', lambda m: ('ATM deposit', None)),
        (r'BOFAFIN CTR .*DEPOSIT', lambda m: ('Banking center deposit', None)),
        (r'^Counter Credit', lambda m: ('Counter deposit', None)),
        (r'^(\S+)\s+DES:IAT PAYPAL', lambda m: (f'PayPal {m[1]}', None)),
    ]
    for pattern, merchant, category in LOCAL['merchants']:
        if re.search(pattern, d):
            return merchant, category
    for pattern, f in rules:
        m = re.search(pattern, d)
        if m:
            return f(m)
    m = re.match(r'(?:CHECKCARD|MOBILE PURCHASE|PURCHASE|PMNT SENT) \d{4} (.*)', d)
    if m:
        for pattern, name in CARD_MERCHANTS:
            if re.search(pattern, m[1], re.I):
                return name, None
        return re.sub(r'\s+(\d{3}-\d{3}-\d{4}|\d{6,}).*$', '', m[1]).strip(), None
    return d[:60], None


def ocr(pdfs):
    for folder, pdf in zip(('checking', 'savings'), pdfs):
        out = os.path.join(ROOT, folder)
        os.makedirs(out, exist_ok=True)
        subprocess.run(['pdftoppm', '-r', '200', '-gray', '-png', pdf, os.path.join(out, 'p')], check=True)
        for png in sorted(glob.glob(os.path.join(out, 'p-*.png'))):
            subprocess.run(['tesseract', png, png[:-4], '--psm', '6'], check=True, capture_output=True)
            os.remove(png)


def main():
    if sys.argv[1:2] == ['--ocr']:
        ocr(sys.argv[2:4])
    fixes = json.load(open(os.path.join(ROOT, 'fixes.json')))
    local_path = os.path.join(ROOT, 'local.json')
    if os.path.exists(local_path):
        LOCAL.update(json.load(open(local_path)))
    failed = False
    result = {}
    for folder in ('checking', 'savings'):
        statements = parse_folder(folder, fixes)
        prev_end = None
        for st in statements:
            issues = problems(st, prev_end)
            prev_end = st['summary'].get('end')
            print(f"{folder:8} {st['start']}..{st['end']} {len(st['rows']):3} rows  {'OK' if not issues else issues}")
            failed |= bool(issues)
            for r in st['rows']:
                r['desc'] = clean(r['desc'])
                r['merchant'], r['category_id'] = classify(r["desc"], r["cents"])
            del st['unparsed']
        result[folder] = statements
    if failed:
        sys.exit('Not written: fix the statements above (fixes.json) and re-run.')
    with open(os.path.join(ROOT, 'statements.json'), 'w') as fh:
        json.dump(result, fh, indent=1)
    n = sum(len(s['rows']) for v in result.values() for s in v)
    print(f'Wrote {n} rows from {sum(len(v) for v in result.values())} statements.')


if __name__ == '__main__':
    main()
