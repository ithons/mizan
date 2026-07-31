#!/usr/bin/env python3
"""Generate canonical backfill CSVs for Wealthfront (savings), Fidelity (contributions
only, per user's choice), and Coinbase (buy/sell/reward, routed per wallet). One file per
account in data/backfill/raw/; category is emitted as the NAME the importer matches on.

Coinbase Converts / Sends / Receives / Deposits / Withdrawals / Dust are intentionally NOT
emitted here: they need dedicated multi-wallet handling and are reported as remaining work.
Requires the venv with stdlib csv/re only.
"""
import csv, io, os, re, glob

RAW = os.path.join(os.getcwd(), 'data', 'backfill', 'raw')
os.makedirs(RAW, exist_ok=True)
COLS = ['account_name', 'date', 'amount', 'merchant', 'category', 'notes']


def write(slug, rows):
    with open(os.path.join(RAW, f'{slug}.csv'), 'w', newline='') as fh:
        w = csv.writer(fh); w.writerow(COLS); w.writerows(rows)
    print(f'  {slug}.csv: {len(rows)} rows' + (f'  {rows[0][1]}..{rows[-1][1]}' if rows else ''))


# ── Wealthfront QFX (OFX/SGML): 3.30% APY savings, cash flows ──────────────────
def wealthfront():
    txt = open(glob.glob('data/wealthfront/*.QFX')[0]).read()
    acct = 'Individual 3.30% APY (2495)'
    rows = []
    for blk in re.findall(r'<STMTTRN>(.*?)</STMTTRN>', txt, re.S) or re.split(r'<STMTTRN>', txt)[1:]:
        d = re.search(r'<DTPOSTED>(\d{8})', blk); amt = re.search(r'<TRNAMT>(-?[\d.]+)', blk)
        typ = re.search(r'<TRNTYPE>(\w+)', blk)
        if not (d and amt): continue
        iso = f'{d.group(1)[:4]}-{d.group(1)[4:6]}-{d.group(1)[6:8]}'
        t = (typ.group(1) if typ else '').upper()
        cat = 'Interest' if t == 'INT' else 'Transfer In'
        merch = 'Wealthfront Interest' if t == 'INT' else 'Wealthfront Deposit'
        rows.append([acct, iso, f'{float(amt.group(1)):.2f}', merch, cat, ''])
    rows.sort(key=lambda r: r[1]); write('wf-savings', rows)


# ── Fidelity: contributions only (Electronic Funds Transfer + Cash Contribution) ─
def fidelity():
    rows = [r for r in csv.reader(open('data/fidelity/Accounts_History.csv'))
            if len(r) >= 13 and r[0][:2].isdigit()]
    def iso(s): m, d, y = s.split('/'); return f'{y}-{m}-{d}'
    for acct, slug in [('Individual', 'fid-ind'), ('ROTH IRA', 'fid-roth')]:
        out = []
        for r in rows:
            if r[1] != acct: continue
            a = r[3].upper()
            if 'ELECTRONIC FUNDS TRANSFER' not in a and 'CASH CONTRIBUTION' not in a: continue
            amt = float(r[12]) if r[12].strip() else 0.0
            if amt == 0: continue
            out.append([f'{acct} ({"9926" if acct=="Individual" else "5710"})',
                        iso(r[0]), f'{amt:.2f}', 'Fidelity contribution', 'Investment Transfer', ''])
        out.sort(key=lambda x: x[1]); write(slug, out)


# ── Coinbase: buy/sell/reward routed to each asset wallet ──────────────────────
def coinbase():
    lines = open(glob.glob('data/coinbase/*.csv')[0]).read().splitlines()
    h = next(i for i, l in enumerate(lines) if l.startswith('ID,'))
    rows = list(csv.DictReader(io.StringIO('\n'.join(lines[h:]))))
    asset_wallet = {'AVAX': 'AVAX Wallet', 'BTC': 'BTC Wallet', 'ETH': 'ETH Wallet',
                    'LINK': 'LINK Wallet', 'POL': 'POL Wallet', 'MATIC': 'POL Wallet', 'SOL': 'SOL Wallet'}

    def usd(x): return float(re.sub(r'[$,]', '', x).strip() or 0)
    buckets = {}
    for r in rows:
        wallet = asset_wallet.get(r['Asset'])
        if not wallet: continue
        t = r['Transaction Type']
        total = usd(r['Total (inclusive of fees and/or spread)'])
        if t in ('Advanced Trade Buy', 'Buy'):
            amt, cat, m = -total, 'Crypto Buy', f'Buy {r["Asset"]}'
        elif t in ('Advanced Trade Sell', 'Sell'):
            amt, cat, m = total, 'Crypto Sell', f'Sell {r["Asset"]}'
        elif 'Reward' in t or 'Incentives' in t:
            amt, cat, m = total, 'Crypto Reward', f'{r["Asset"]} reward'
        else:
            continue  # convert/send/receive/deposit/withdrawal/dust: deferred
        iso = r['Timestamp'][:10]
        buckets.setdefault(wallet, []).append([wallet, iso, f'{amt:.2f}', m, cat, ''])
    for wallet, out in buckets.items():
        out.sort(key=lambda x: x[1])
        write('cb-' + wallet.split()[0].lower(), out)


print('Wealthfront:'); wealthfront()
print('Fidelity (contributions only):'); fidelity()
print('Coinbase (buy/sell/reward only):'); coinbase()
