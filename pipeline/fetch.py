"""
Fetch NSE files and store one compact file per trading day.

  data/days/YYYY-MM-DD.csv.gz   one row per stock: margin book + price, volume, delivery
  data/days/YYYY-MM-DD.json     the day's book totals, index closes and cash turnover
  data/mcap/YYYY-MM.csv.gz      shares outstanding and market cap, first trading day of each month
  data/mcap/latest.csv.gz       the same for the latest day
  data/ref/                     F&O list, ETF list, sector map

Incremental and safe to re-run: days already stored are skipped.
Usage: python pipeline/fetch.py [--since 2021-12-01] [--raw-dir PATH]
"""
import argparse
import gzip
import io
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DAYS = ROOT / "data" / "days"
MCAP = ROOT / "data" / "mcap"
REF = ROOT / "data" / "ref"
HOLIDAYS = ROOT / "data" / "holidays.txt"

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
           "Accept": "*/*", "Referer": "https://www.nseindia.com/"}
URL_MTF = "https://nsearchives.nseindia.com/content/equities/mrg_trading_{d:%d%m%y}.zip"
URL_BHAV = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv"
URL_IDX = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{d:%d%m%Y}.csv"
URL_PR = "https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR{d:%d%m%y}.zip"
REFS = {
    "fo_mktlots.csv": "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv",
    "etf_list.csv": "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv",
    "nifty_total_market.csv": "https://niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv",
    "nifty500.csv": "https://niftyindices.com/IndexConstituent/ind_nifty500list.csv",
}
INDICES = {"Nifty 50": "nifty50", "Nifty 500": "nifty500", "Nifty Midcap 150": "midcap150",
           "Nifty Smallcap 250": "smallcap250", "India VIX": "vix"}
SERIES_OK = ("EQ", "BE", "BZ", "SM", "ST")

session = requests.Session()
session.headers.update(HEADERS)


def get(url, tries=3):
    for i in range(tries):
        try:
            r = session.get(url, timeout=40)
            if r.status_code == 200 and r.content:
                return r.content
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(2 * (i + 1))
    return None


def parse_mtf(text):
    """Handles both layouts. Revised reports put the original and the revised
    figures side by side; the revised (rightmost) numbers win, since they
    include late member submissions."""
    lines = text.splitlines()
    head = {}
    for l in lines[:14]:
        p = [x.strip() for x in l.split(",")]
        for j, cell in enumerate(p[:-2]):
            if cell in ("1", "2", "3", "4"):
                try:
                    head[cell] = float(p[j + 2])
                except ValueError:
                    pass
    rows = {}
    start = next((i for i, l in enumerate(lines) if l.lower().lstrip(",").startswith("symbol,")), None)
    if start is None:
        return head, rows
    for l in lines[start + 1:]:
        p = [x.strip() for x in l.split(",")]
        if len(p) >= 10 and p[6]:
            p = p[6:10]
        if len(p) < 4 or not p[0]:
            continue
        try:
            rows[p[0]] = (p[1], float(p[2]), float(p[3]))
        except ValueError:
            continue
    return head, rows


def num(x):
    x = x.strip()
    try:
        return float(x)
    except ValueError:
        return None


def parse_bhav(text):
    lines = text.splitlines()
    cols = [c.strip() for c in lines[0].split(",")]
    ix = {c: i for i, c in enumerate(cols)}
    out = {}
    need = ("SYMBOL", "SERIES", "OPEN_PRICE", "PREV_CLOSE", "CLOSE_PRICE", "TTL_TRD_QNTY", "TURNOVER_LACS", "DELIV_QTY")
    if not all(c in ix for c in need):
        return out
    for l in lines[1:]:
        p = [x.strip() for x in l.split(",")]
        if len(p) < len(cols) or p[ix["SERIES"]] not in SERIES_OK:
            continue
        sym, ser = p[ix["SYMBOL"]], p[ix["SERIES"]]
        if sym in out and SERIES_OK.index(out[sym]["series"]) <= SERIES_OK.index(ser):
            continue
        out[sym] = dict(series=ser, open=num(p[ix["OPEN_PRICE"]]), prev=num(p[ix["PREV_CLOSE"]]),
                        close=num(p[ix["CLOSE_PRICE"]]), vol=num(p[ix["TTL_TRD_QNTY"]]),
                        turn=num(p[ix["TURNOVER_LACS"]]), deliv=num(p[ix["DELIV_QTY"]]))
    return out


def parse_idx(text):
    out = {}
    for l in text.splitlines()[1:]:
        p = l.split(",")
        if len(p) > 5 and p[0].strip() in INDICES:
            v = num(p[5])
            if v is not None:
                out[INDICES[p[0].strip()]] = v
    return out


def local_or_fetch(path_candidates, url, unzip=False):
    for p in path_candidates:
        if p and p.exists():
            return p.read_text(encoding="utf-8", errors="ignore")
    blob = get(url)
    if not blob:
        return None
    if unzip:
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                # some older archives nest the file in a folder or use another extension: take the largest file
                files = [i for i in z.infolist() if not i.is_dir()]
                if not files:
                    return None
                return z.read(max(files, key=lambda i: i.file_size)).decode("utf-8", "ignore")
        except zipfile.BadZipFile:
            return None
    return blob.decode("utf-8", "ignore")


def fetch_day(d, raw_dir):
    out_csv = DAYS / f"{d:%Y-%m-%d}.csv.gz"
    if out_csv.exists():
        return d, True
    rd = Path(raw_dir) if raw_dir else None
    mtf_txt = local_or_fetch([rd / "mtf" / f"mrg_trading_{d:%d%m%Y}.csv" if rd else None], URL_MTF.format(d=d), unzip=True)
    if not mtf_txt:
        return d, False
    head, mtf = parse_mtf(mtf_txt)
    bhav_txt = get(URL_BHAV.format(d=d))   # raw bhav was filtered earlier, so always take NSE's full file
    bhav = parse_bhav(bhav_txt.decode("utf-8", "ignore")) if bhav_txt else {}
    idx_txt = get(URL_IDX.format(d=d))
    idx = parse_idx(idx_txt.decode("utf-8", "ignore")) if idx_txt else {}

    lines = ["symbol,series,mtf_qty,mtf_lakh,open,prev,close,vol,turn_lakh,deliv"]
    fmt = lambda v: "" if v is None else (f"{v:.2f}" if isinstance(v, float) and v % 1 else f"{v:.0f}")
    for sym in sorted(set(bhav) | set(mtf)):
        b = bhav.get(sym, {})
        m = mtf.get(sym)
        lines.append(",".join([sym, b.get("series", ""), fmt(m[1]) if m else "", fmt(m[2]) if m else "",
                               fmt(b.get("open")), fmt(b.get("prev")), fmt(b.get("close")), fmt(b.get("vol")),
                               fmt(b.get("turn")), fmt(b.get("deliv"))]))
    names = {s: v[0] for s, v in mtf.items()}
    meta = dict(date=f"{d:%Y-%m-%d}", book_start_lakh=head.get("1"), fresh_lakh=head.get("2"),
                closed_lakh=head.get("3"), book_lakh=head.get("4"),
                cash_turnover_cr=round(sum((b.get("turn") or 0) for b in bhav.values() if b["series"] in ("EQ", "BE")) / 100, 2) if bhav else None,
                indices=idx, has_bhav=bool(bhav))
    out_csv.write_bytes(gzip.compress("\n".join(lines).encode(), mtime=0))
    (DAYS / f"{d:%Y-%m-%d}.json").write_text(json.dumps(meta))
    (DAYS / f"{d:%Y-%m-%d}.names.json").write_text(json.dumps(names, separators=(",", ":")))
    return d, True


def fetch_mcap(d, name):
    out = MCAP / f"{name}.csv.gz"
    blob = get(URL_PR.format(d=d))
    if not blob:
        return False
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        cand = [n for n in z.namelist() if n.lower().startswith("mcap") and n.lower().endswith(".csv")]
        if not cand:
            return False
        txt = z.read(cand[0]).decode("utf-8", "ignore")
    rows = ["symbol,series,shares,mcap_cr"]
    for l in txt.splitlines()[1:]:
        p = [x.strip() for x in l.split(",")]
        if len(p) < 10 or p[2] not in SERIES_OK:
            continue
        try:
            rows.append(f"{p[1]},{p[2]},{float(p[7]):.0f},{float(p[9]) / 1e7:.2f}")
        except ValueError:
            continue
    out.write_bytes(gzip.compress("\n".join(rows).encode(), mtime=0))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=None, help="first date to fetch, YYYY-MM-DD")
    ap.add_argument("--days", type=int, default=15, help="look back this many calendar days when --since is not given")
    ap.add_argument("--raw-dir", default=None, help="folder of MTF files already downloaded")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    for p in (DAYS, MCAP, REF):
        p.mkdir(parents=True, exist_ok=True)

    for name, url in REFS.items():
        blob = get(url)
        if blob:
            (REF / name).write_bytes(blob)

    today = date.today()
    start = datetime.strptime(a.since, "%Y-%m-%d").date() if a.since else today - timedelta(days=a.days)
    hol = set(HOLIDAYS.read_text().split()) if HOLIDAYS.exists() else set()
    todo = []
    d = start
    while d <= today:
        if d.weekday() < 5 and d.isoformat() not in hol and not (DAYS / f"{d:%Y-%m-%d}.csv.gz").exists():
            todo.append(d)
        d += timedelta(days=1)
    print(f"{len(todo)} candidate days")
    new_hol, got = [], 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        def safe(x):
            try:
                return fetch_day(x, a.raw_dir)
            except Exception as e:  # one bad file should not stop the backfill
                print(f"  {x}: {type(e).__name__} {e}")
                return x, None
        for i, (d, ok) in enumerate(ex.map(safe, todo), 1):
            if ok:
                got += 1
            elif ok is False and (today - d).days > 7:   # the MTF file lands a day late, so only call a day a holiday once it is old
                new_hol.append(d.isoformat())
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}")
    if new_hol:
        HOLIDAYS.write_text("\n".join(sorted(hol | set(new_hol))))

    # market cap: first stored trading day of each month, plus the latest day
    stored = sorted(p.name[:10] for p in DAYS.glob("*.csv.gz"))
    firsts = {}
    for s in stored:
        firsts.setdefault(s[:7], s)
    for month, s in firsts.items():
        if not (MCAP / f"{month}.csv.gz").exists():
            fetch_mcap(datetime.strptime(s, "%Y-%m-%d").date(), month)
    if stored:
        fetch_mcap(datetime.strptime(stored[-1], "%Y-%m-%d").date(), "latest")
    print(f"stored {got} new days; total {len(stored)} days, latest {stored[-1] if stored else None}")


if __name__ == "__main__":
    main()
