"""
Build the website's data from the stored NSE days.

Reads data/days, data/mcap, data/ref and writes dist/data/*.json plus one file
per stock in dist/data/s/. Every section carries an `insights` list: plain
sentences worked out from the numbers, so each chart says what it means.
Usage: python pipeline/build.py
"""
import gzip
import io
import json
import shutil
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DAYS = ROOT / "data" / "days"
MCAP = ROOT / "data" / "mcap"
REF = ROOT / "data" / "ref"
SITE = ROOT / "site"
DIST = ROOT / "dist"
OUT = DIST / "data"

MIN_ADV_CR, MIN_MTF_CR, MIN_PRICE = 10.0, 10.0, 20.0


# ------------------------------------------------------------------ formatting
def ind(n):
    """Indian digit grouping: 1234567 -> 12,34,567"""
    s = f"{abs(n):.0f}"
    head, tail = s[:-3], s[-3:]
    while len(head) > 2:
        tail = head[-2:] + "," + tail
        head = head[:-2]
    out = (head + "," + tail) if head else tail
    return ("-" if n < 0 else "") + out


def cr(x):
    if x is None or pd.isna(x):
        return "n/a"
    sg, a = ("−" if x < 0 else ""), abs(x)
    if a >= 1e5:
        return f"{sg}₹{a / 1e5:.2f} lakh cr"
    if a >= 100:
        return f"{sg}₹{ind(a)} cr"
    return f"{sg}₹{a:.1f} cr"


def pc(x, d=1, sign=True):
    if x is None or pd.isna(x):
        return "n/a"
    s = f"{x * 100:+.{d}f}%" if sign else f"{x * 100:.{d}f}%"
    return s.replace("-", "−")


def dfmt(ts):
    return pd.Timestamp(ts).strftime("%-d %b %Y") if hasattr(pd.Timestamp(ts), "strftime") else str(ts)


def dd(ts):
    t = pd.Timestamp(ts)
    return f"{t.day} {t.strftime('%b %Y')}"


def rnd(x, n=2):
    if x is None:
        return None
    try:
        if pd.isna(x) or np.isinf(x):
            return None
    except TypeError:
        return x
    return round(float(x), n)


def dump(name, obj):
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False, default=lambda o: None), encoding="utf-8")


# ------------------------------------------------------------------ load
def load():
    frames, metas, names = [], [], {}
    for f in sorted(DAYS.glob("*.csv.gz")):
        d = f.name[:10]
        df = pd.read_csv(io.BytesIO(gzip.decompress(f.read_bytes())), dtype={"symbol": str, "series": str})
        df["date"] = d
        frames.append(df)
        mf = DAYS / f"{d}.json"
        if mf.exists():
            metas.append(json.loads(mf.read_text()))
        nf = DAYS / f"{d}.names.json"
        if nf.exists():
            names.update(json.loads(nf.read_text()))
    raw = pd.concat(frames, ignore_index=True)
    raw["date"] = pd.to_datetime(raw["date"])
    meta = pd.DataFrame(metas)
    meta["date"] = pd.to_datetime(meta["date"])
    meta = meta.set_index("date").sort_index()
    return raw, meta, names


def load_refs():
    fo, etf, sector = set(), set(), {}
    f = REF / "fo_mktlots.csv"
    if f.exists():
        for l in f.read_text(errors="ignore").splitlines()[1:]:
            p = [x.strip() for x in l.split(",")]
            if len(p) > 1 and p[1] and p[1] not in ("SYMBOL",) and "NIFTY" not in p[1]:
                fo.add(p[1])
    f = REF / "etf_list.csv"
    if f.exists():
        e = pd.read_csv(f, dtype=str)
        etf = set(e.iloc[:, 0].str.strip())
    for name in ("nifty_total_market.csv", "nifty500.csv"):
        f = REF / name
        if f.exists():
            try:
                n = pd.read_csv(f, dtype=str)
                for s, i in zip(n["Symbol"].str.strip(), n["Industry"].str.strip()):
                    sector.setdefault(s, i)
            except Exception:
                pass
    return fo, etf, sector


def load_mcap(dates, close, fac):
    """Daily market cap (Rs cr). Each day uses the nearest earlier monthly share
    count, moved onto that day's share basis with the split factor; days before
    the first snapshot (NSE's file starts in Feb 2024) use the first one."""
    snaps = {}
    for f in sorted(MCAP.glob("*.csv.gz")):
        m = pd.read_csv(io.BytesIO(gzip.decompress(f.read_bytes())), dtype={"symbol": str})
        snaps[f.name[:-7]] = m.drop_duplicates("symbol").set_index("symbol")
    if not snaps:
        return None, None
    month_of = pd.Series(dates.strftime("%Y-%m"), index=dates)
    rows = {}
    for mth in sorted(k for k in snaps if k != "latest"):
        hit = month_of[month_of == mth]
        if len(hit):
            rows[hit.index[0]] = snaps[mth]["shares"]
    if "latest" in snaps:
        rows[dates[-1]] = snaps["latest"]["shares"]
    S = pd.DataFrame(rows).T.reindex(columns=close.columns)
    F = fac.loc[S.index]
    S = S.reindex(dates).ffill().bfill()
    F = F.reindex(dates).ffill().bfill()
    mcap = close * fac / F * S / 1e7
    latest_mcap = snaps["latest"]["mcap_cr"] if "latest" in snaps else mcap.iloc[-1]
    return mcap, latest_mcap


# ------------------------------------------------------------------ panel
def panel(raw):
    piv = lambda c: raw.pivot_table(index="date", columns="symbol", values=c, aggfunc="last")
    amt = piv("mtf_lakh").fillna(0) / 100.0
    close, opn, prev = piv("close"), piv("open"), piv("prev")
    vol, turn, deliv = piv("vol"), piv("turn_lakh") / 100.0, piv("deliv")
    idx = amt.index.union(close.index)
    cols = amt.columns.union(close.columns)
    R = lambda x: x.reindex(index=idx, columns=cols)
    amt, close, opn, prev, vol, turn, deliv = map(R, (amt, close, opn, prev, vol, turn, deliv))
    amt = amt.fillna(0)
    # split / bonus detection: NSE does not restate PREV_CLOSE, so snap big opening gaps to standard ratios
    gap = opn / prev
    snaps = np.array([1 / 2, 1 / 3, 1 / 4, 1 / 5, 2 / 3, 1 / 10, 1 / 20, 2, 5, 10])
    g = gap.values
    ratio = np.ones_like(g)
    cand = (~np.isnan(g)) & ((g <= 0.7) | (g >= 1.6))
    if cand.any():
        gv = g[cand]
        best = snaps[np.argmin(np.abs(np.log(snaps[None, :] / gv[:, None])), axis=1)]
        ok = np.abs(np.log(best / gv)) < 0.08
        ratio[cand] = np.where(ok, best, 1.0)
    ratio = pd.DataFrame(ratio, index=idx, columns=cols)
    fac = ratio[::-1].cumprod()[::-1].shift(-1).fillna(1.0)
    adj = close * fac
    deliv_cr = deliv * close / 1e7
    jump = (adj / adj.shift(1) - 1).abs() > 0.4
    return dict(fac=fac, amt=amt, close=close, adj=adj, vol=vol, turn=turn, deliv=deliv, deliv_cr=deliv_cr, jump=jump)


def stamp_assets(version):
    """Add ?v= to asset links so browsers fetch new code after each build."""
    v = "".join(ch for ch in version if ch.isalnum())
    page = DIST / "index.html"
    html = page.read_text(encoding="utf-8")
    for a in ("assets/style.css", "assets/app.js", "assets/echarts.min.js"):
        html = html.replace(f'"{a}"', f'"{a}?v={v}"')
    page.write_text(html, encoding="utf-8")


# ------------------------------------------------------------------ main
def main():
    shutil.rmtree(DIST, ignore_errors=True)   # a local preview server may hold files open; refresh in place
    shutil.copytree(SITE, DIST, dirs_exist_ok=True)
    (OUT / "s").mkdir(parents=True, exist_ok=True)

    raw, meta, names = load()
    fo, etf, sector = load_refs()
    P = panel(raw)
    amt, adj, close = P["amt"], P["adj"], P["close"]
    dates = amt.index
    mcap, latest_mcap = load_mcap(dates, close, P["fac"])
    T = dates[-1]
    asof = T.strftime("%Y-%m-%d")

    # ---------- book series (header totals; fall back to the stock sum)
    meta = meta.reindex(dates)
    book = (meta["book_lakh"] / 100).where(meta["book_lakh"].notna(), amt.sum(axis=1))
    fresh = meta["fresh_lakh"] / 100
    closed = meta["closed_lakh"] / 100
    net = fresh - closed
    nsec = (amt > 0).sum(axis=1)
    idx = pd.DataFrame(list(meta["indices"].apply(lambda x: x if isinstance(x, dict) else {})), index=dates)
    cash_turn = meta["cash_turnover_cr"]
    turn20 = cash_turn.rolling(20, min_periods=5).mean()
    footprint = ((fresh + closed) / cash_turn).where(cash_turn > 0)
    book_days_turn = book / turn20
    eq_cols = [c for c in amt.columns if c not in etf]
    total_mcap = mcap[eq_cols].sum(axis=1, min_count=1) if mcap is not None else None
    book_pct_mcap = book / total_mcap if total_mcap is not None else None

    # ---------- classification
    if mcap is not None:
        rank = mcap[eq_cols].rank(axis=1, ascending=False)
    cap_class = pd.DataFrame("Micro", index=dates, columns=amt.columns)
    tier = pd.DataFrame("1000+", index=dates, columns=amt.columns)
    if mcap is not None:
        r = rank.reindex(columns=amt.columns)
        cap_class = cap_class.mask(r <= 500, "Small").mask(r <= 250, "Mid").mask(r <= 100, "Large")
        tier = tier.mask(r <= 1000, "501-1000").mask(r <= 500, "251-500").mask(r <= 250, "101-250").mask(r <= 100, "Top 100")
        cap_class = cap_class.where(r.notna(), "Unranked")
        tier = tier.where(r.notna(), "Unranked")
    etf_cols = [c for c in amt.columns if c in etf]
    cap_class[etf_cols] = "ETF"
    tier[etf_cols] = "ETF"
    grp_type = pd.Series({c: ("ETF" if c in etf else "F&O" if c in fo else "Non-F&O") for c in amt.columns})
    sec = pd.Series({c: ("ETF" if c in etf else sector.get(c, "Others")) for c in amt.columns})

    def group_sum(labels_df_or_series, keys):
        out = {}
        for k in keys:
            if isinstance(labels_df_or_series, pd.Series):
                out[k] = amt.loc[:, labels_df_or_series[labels_df_or_series == k].index].sum(axis=1)
            else:
                out[k] = amt.where(labels_df_or_series == k).sum(axis=1)
        return pd.DataFrame(out)

    comp_type = group_sum(grp_type, ["F&O", "Non-F&O", "ETF"])
    comp_cap = group_sum(cap_class, ["Large", "Mid", "Small", "Micro", "ETF", "Unranked"])
    comp_tier = group_sum(tier, ["Top 100", "101-250", "251-500", "501-1000", "1000+", "ETF", "Unranked"])

    # ---------- stock metrics
    deliv20 = P["deliv_cr"].rolling(20, min_periods=10).mean()
    dtu = (amt / deliv20).where(amt > 0)
    adv20 = P["turn"].rolling(20, min_periods=10).mean()
    dpct = P["deliv"].rolling(20, min_periods=10).sum() / P["vol"].rolling(20, min_periods=10).sum()
    ret = lambda k: (adj / adj.shift(k) - 1).where(~P["jump"].rolling(k, min_periods=1).max().astype(bool))
    lag = lambda k: amt.shift(k)
    lr = np.log(amt.where(amt > 0)).diff()
    z = (lr - lr.rolling(60, min_periods=30).mean()) / lr.rolling(60, min_periods=30).std()
    mtf_mcap = (amt / mcap).where(amt > 0) if mcap is not None else None

    # ---------- weighted crowding and stress index
    w = amt.where(dtu.notna())
    crowd = (dtu.clip(upper=60) * w).sum(axis=1) / w.sum(axis=1)
    g60 = book / book.shift(60) - 1
    foot20 = footprint.rolling(20, min_periods=5).mean()
    comps = pd.DataFrame({"leverage": book_pct_mcap if book_pct_mcap is not None else book_days_turn,
                          "growth": g60, "footprint": foot20, "crowding": crowd})
    pct_rank = comps.rank(pct=True)
    stress = (pct_rank.mean(axis=1) * 100).where(comps.notna().sum(axis=1) >= 3)

    # ================================================================ OVERVIEW
    def at_or_before(n_days):
        tgt = T - pd.Timedelta(days=n_days)
        s = book[book.index <= tgt].dropna()
        return (s.index[-1], s.iloc[-1]) if len(s) else (None, None)

    b = book.dropna()
    cur, prev_ = b.iloc[-1], b.iloc[-2]
    ath_d = b.idxmax()
    chg = {}
    for label, nd in (("30D", 30), ("90D", 90), ("6M", 182), ("1Y", 365), ("3Y", 1095)):
        d0, v0 = at_or_before(nd)
        if v0:
            chg[label] = dict(ref_date=d0.strftime("%Y-%m-%d"), ref=rnd(v0), abs=rnd(cur - v0), pct=rnd(cur / v0 - 1, 4))
    latest = amt.loc[T]
    latest = latest[latest > 0].sort_values(ascending=False)
    tot = latest.sum()
    cum = latest.cumsum() / tot
    half_n = int((cum < 0.5).sum() + 1)
    by_type_now = comp_type.loc[T]
    n50 = idx.get("nifty500")
    ov = dict(
        asof=asof, book=rnd(cur), prev=rnd(prev_), d1=rnd(cur / prev_ - 1, 4), securities=int(nsec.loc[T]),
        fresh=rnd(fresh.loc[T]), closed=rnd(closed.loc[T]), net=rnd(net.loc[T]),
        fresh_prev=rnd(fresh.iloc[-2]), closed_prev=rnd(closed.iloc[-2]),
        net30=rnd(net.tail(30).mean()), changes=chg,
        ath=rnd(b.max()), ath_date=ath_d.strftime("%Y-%m-%d"), ath_days=int((T - ath_d).days),
        avg7=rnd(b.tail(7).mean()),
        max_in=rnd(net.max()), max_in_date=net.idxmax().strftime("%Y-%m-%d"),
        max_out=rnd(net.min()), max_out_date=net.idxmin().strftime("%Y-%m-%d"),
        top_stock=latest.index[0], top_stock_amt=rnd(latest.iloc[0]), top_share=rnd(latest.iloc[0] / tot, 4),
        top10_share=rnd(latest.head(10).sum() / tot, 4), top10_amt=rnd(latest.head(10).sum()),
        half_n=half_n, half_amt=rnd(latest.head(half_n).sum()),
        fo=rnd(by_type_now["F&O"]), nonfo=rnd(by_type_now["Non-F&O"]), etf=rnd(by_type_now["ETF"]),
        book_pct_mcap=rnd(book_pct_mcap.loc[T], 6) if book_pct_mcap is not None else None,
        stress=rnd(stress.loc[T], 1), history_start=dates[0].strftime("%Y-%m-%d"), days=len(dates),
    )
    # insights
    ins = []
    if "1Y" in chg and n50 is not None:
        n_now, n_then = n50.loc[T], n50[n50.index <= pd.Timestamp(chg["1Y"]["ref_date"])].dropna()
        if len(n_then):
            mret = n_now / n_then.iloc[-1] - 1
            ratio = chg["1Y"]["pct"] / mret if mret and mret > 0 else None
            ins.append(f"The margin book grew {pc(chg['1Y']['pct'])} in a year while the Nifty 500 moved {pc(mret)}."
                       + (f" Leverage is growing about {ratio:.1f} times as fast as the market." if ratio and ratio > 1.2 else ""))
    if ov["ath_days"] == 0:
        ins.append("The book closed at a new all-time high today.")
    else:
        ins.append(f"The book is {pc(1 - cur / b.max(), sign=False)} below its all-time high of {cr(b.max())}, set {ov['ath_days']} days ago on {dd(ath_d)}.")
    streak = 0
    for v in net.dropna()[::-1]:
        if (v < 0) == (net.loc[T] < 0):
            streak += 1
        else:
            break
    ins.append(f"Today brought a net {'outflow' if net.loc[T] < 0 else 'inflow'} of {cr(abs(net.loc[T]))}"
               + (f", the {streak}{'th' if streak > 3 else ['', 'st', 'nd', 'rd'][streak]} straight day of net {'selling' if net.loc[T] < 0 else 'buying'}." if streak > 1 else "."))
    ins.append(f"Concentration is low: the top 10 stocks hold {pc(ov['top10_share'], sign=False)} of the book and it takes {half_n} stocks to reach half of it.")
    ins.append(f"Stocks outside F&O carry {pc(ov['nonfo'] / tot, sign=False)} of the book. Those names have no derivative hedge and thinner liquidity, so an unwind there hits harder.")
    ov["insights"] = ins
    dump("overview.json", ov)

    # ================================================================ TIME SERIES
    def col(s, n=2):
        return [rnd(v, n) for v in s.reindex(dates)]
    ts = dict(
        dates=[d.strftime("%Y-%m-%d") for d in dates], book=col(book), fresh=col(fresh), closed=col(closed), net=col(net),
        securities=[int(v) for v in nsec], nifty50=col(idx.get("nifty50", pd.Series(dtype=float))),
        nifty500=col(idx.get("nifty500", pd.Series(dtype=float))), midcap150=col(idx.get("midcap150", pd.Series(dtype=float))),
        smallcap250=col(idx.get("smallcap250", pd.Series(dtype=float))), vix=col(idx.get("vix", pd.Series(dtype=float))),
        cash_turnover=col(cash_turn), footprint=col(footprint, 4), book_days_turnover=col(book_days_turn, 2),
        book_pct_mcap=col(book_pct_mcap, 6) if book_pct_mcap is not None else None,
        stress=col(stress, 1), crowding=col(crowd, 2),
        comp_type={k: col(v) for k, v in comp_type.items()},
        comp_cap={k: col(v) for k, v in comp_cap.items() if v.sum() > 0},
        comp_tier={k: col(v) for k, v in comp_tier.items() if v.sum() > 0},
    )
    dump("timeseries.json", ts)

    # ================================================================ CONTEXT (market, liquidity, footprint, stress)
    ctx = {}
    bd = book_days_turn.dropna()
    ctx["liquidity"] = [
        f"The book equals {bd.iloc[-1]:.1f} days of the whole cash market's average turnover. Its range since {dd(bd.index[0])} is {bd.min():.1f} to {bd.max():.1f} days.",
        f"Today sits at the {bd.rank(pct=True).iloc[-1] * 100:.0f}th percentile of that history"
        + (", so leverage is heavy relative to what actually trades." if bd.rank(pct=True).iloc[-1] > 0.75 else
           ", a light reading against what actually trades." if bd.rank(pct=True).iloc[-1] < 0.25 else ", a middle-of-the-range reading."),
    ]
    fp = foot20.dropna()
    ctx["footprint"] = [
        f"Margin buying and selling made up {pc(fp.iloc[-1], sign=False)} of cash-market turnover over the last 20 days, against {pc(fp.mean(), sign=False)} on average since {dd(fp.index[0])}.",
        "A rising share means price moves depend more on leveraged traders, who must sell on margin calls." if fp.iloc[-1] > fp.mean()
        else "Leveraged flow is a smaller share of trading than usual, so it is less likely to drive day-to-day prices.",
    ]
    if book_pct_mcap is not None:
        bm = book_pct_mcap.dropna()
        ctx["mcap"] = [f"The margin book is {pc(bm.iloc[-1], 2, False)} of the market value of all listed NSE stocks, compared with {pc(bm.iloc[0], 2, False)} in {pd.Timestamp(bm.index[0]).year}.",
                       "Leverage has grown faster than market value." if bm.iloc[-1] > bm.iloc[0] * 1.15 else "Leverage has broadly kept pace with market value."]
    st = stress.dropna()
    zone = "elevated" if st.iloc[-1] >= 70 else "calm" if st.iloc[-1] <= 30 else "moderate"
    drivers = pct_rank.loc[T].sort_values(ascending=False)
    names_map = {"leverage": "book size relative to market value", "growth": "3-month book growth",
                 "footprint": "margin share of trading", "crowding": "days needed to unwind positions"}
    ctx["stress"] = [
        f"The Leverage Stress Index reads {st.iloc[-1]:.0f} out of 100, which is {zone}. It peaked at {st.max():.0f} on {dd(st.idxmax())}.",
        f"The biggest contributor today is {names_map[drivers.index[0]]} (at the {drivers.iloc[0] * 100:.0f}th percentile of its history); the smallest is {names_map[drivers.index[-1]]}.",
        "The index averages four readings, each ranked against every day since December 2021. It measures how hard a forced unwind would hit, not where prices go next.",
    ]
    ctx["stress_components"] = {k: rnd(v, 3) for k, v in pct_rank.loc[T].items()}
    # composition insights
    sh_now = comp_type.loc[T] / comp_type.loc[T].sum()
    y1 = dates[max(0, len(dates) - 250)]
    sh_then = comp_type.loc[y1] / comp_type.loc[y1].sum()
    ctx["comp_type"] = [f"F&O stocks are {pc(sh_now['F&O'], sign=False)} of the book, non-F&O {pc(sh_now['Non-F&O'], sign=False)} and ETFs {pc(sh_now['ETF'], sign=False)}.",
                        f"A year ago non-F&O names were {pc(sh_then['Non-F&O'], sign=False)}, so the book has moved "
                        + ("further into stocks without a derivatives market." if sh_now["Non-F&O"] > sh_then["Non-F&O"] + 0.01 else
                           "towards the more liquid F&O names." if sh_now["Non-F&O"] < sh_then["Non-F&O"] - 0.01 else "very little between the two."),
                        "Note: F&O and ETF membership uses today's lists for the whole history."]
    cc = comp_cap.loc[T].drop(["Unranked"], errors="ignore")
    cc_then = comp_cap.loc[y1].drop(["Unranked"], errors="ignore")
    small = (cc.get("Small", 0) + cc.get("Micro", 0)) / cc.sum()
    small_then = (cc_then.get("Small", 0) + cc_then.get("Micro", 0)) / cc_then.sum()
    ctx["comp_cap"] = [f"Small and micro caps (outside the top 250 by market value) hold {pc(small, sign=False)} of the book, against {pc(small_then, sign=False)} a year ago.",
                       f"Large caps hold {pc(cc.get('Large', 0) / cc.sum(), sign=False)} even though they are most of the market's value, so margin money leans heavily towards smaller companies.",
                       "Cap classes follow SEBI's method: rank 1 to 100 by market value is large, 101 to 250 mid, the rest small and micro."]
    dump("context.json", ctx)

    # ================================================================ FLOWS
    nf = net.dropna()
    wk = nf.resample("W-FRI").sum()
    mo = nf.resample("ME").sum()
    mo_start = book.resample("ME").first()
    mo_pct = (mo / mo_start).dropna()
    wd = nf.groupby(nf.index.dayofweek).mean()
    mon = nf.groupby(nf.index.month).mean()
    dom = nf.groupby(nf.index.day).mean()
    yr_end = book.dropna().groupby(book.dropna().index.year).last()
    cal = nf[nf.index > T - pd.Timedelta(days=371)]
    # margin flushes: 5-day book fall of 3% or more, grouped into episodes
    b5 = book / book.shift(5) - 1
    hits = b5[b5 <= -0.03].index
    episodes = []
    for d in hits:
        if episodes and (d - episodes[-1]["end"]).days <= 10:
            episodes[-1]["end"] = d
        else:
            episodes.append({"start": d, "end": d})
    flush = []
    n500 = idx.get("nifty500")
    for e in episodes:
        s0 = book[book.index < e["start"]].tail(6)
        if len(s0) < 2:
            continue
        top_d = s0.idxmax()
        win = book[(book.index >= top_d) & (book.index <= e["end"] + pd.Timedelta(days=7))]
        low_d = win.idxmin()
        drop = win.min() / book.loc[top_d] - 1
        rec = book[(book.index > low_d) & (book >= book.loc[top_d])]
        mkt = (n500.loc[low_d] / n500.loc[top_d] - 1) if n500 is not None and pd.notna(n500.get(low_d)) and pd.notna(n500.get(top_d)) else None
        flush.append(dict(start=top_d.strftime("%Y-%m-%d"), low=low_d.strftime("%Y-%m-%d"), drop=rnd(drop, 4),
                          drop_cr=rnd(win.min() - book.loc[top_d]), nifty500=rnd(mkt, 4),
                          recovered=rec.index[0].strftime("%Y-%m-%d") if len(rec) else None,
                          days_to_recover=int((rec.index[0] - low_d).days) if len(rec) else None))
    best_m, worst_m = mo_pct.idxmax(), mo_pct.idxmin()
    wd_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    flows = dict(
        weekly=dict(dates=[d.strftime("%Y-%m-%d") for d in wk.index], net=[rnd(v) for v in wk]),
        monthly=dict(dates=[d.strftime("%Y-%m") for d in mo.index], net=[rnd(v) for v in mo], pct=[rnd(mo_pct.get(d), 4) for d in mo.index]),
        weekday=[dict(day=wd_names[i], avg=rnd(v)) for i, v in wd.items() if i < 5],
        month=[dict(month=pd.Timestamp(2000, i, 1).strftime("%b"), avg=rnd(v)) for i, v in mon.items()],
        dom=[dict(day=int(i), avg=rnd(v)) for i, v in dom.items()],
        year_end=[dict(year=int(y), book=rnd(v)) for y, v in yr_end.items()],
        calendar=[[d.strftime("%Y-%m-%d"), rnd(v)] for d, v in cal.items()],
        flushes=flush,
    )
    up_m = (mo > 0).mean()
    fl_rec = [f for f in flush if f["days_to_recover"] is not None]
    flows["insights"] = dict(
        over_time=[f"Margin traders added money in {pc(up_m, 0, False)} of months since {dd(nf.index[0])}.",
                   f"The strongest month was {best_m.strftime('%b %Y')} ({pc(mo_pct.max())} of the opening book) and the weakest {worst_m.strftime('%b %Y')} ({pc(mo_pct.min())})."],
        weekday=[f"{wd_names[int(wd.idxmax())]} has the biggest average net inflow ({cr(wd.max())}) and {wd_names[int(wd.idxmin())]} the weakest ({cr(wd.min())}).",
                 "Weekday gaps are small next to the day-to-day noise, so treat them as a tendency, not a rule."],
        month=[f"On average {pd.Timestamp(2000, int(mon.idxmax()), 1).strftime('%B')} sees the most net margin buying per day and {pd.Timestamp(2000, int(mon.idxmin()), 1).strftime('%B')} the least.",
               f"With under five years of data each month appears only four or five times, so one big year can set the pattern."],
        dom=[f"Net flow is strongest around day {int(dom.idxmax())} of the month and weakest around day {int(dom.idxmin())}.",
             "Month-end flows can reflect salary-cycle buying and broker month-end risk checks."],
        calendar=[f"Over the last year there were {(cal > 0).sum()} days of net inflow and {(cal < 0).sum()} of net outflow.",
                  f"The largest single inflow was {cr(cal.max())} on {dd(cal.idxmax())}; the largest outflow {cr(abs(cal.min()))} on {dd(cal.idxmin())}."],
        year_end=[f"The book ended {int(yr_end.index[-2])} at {cr(yr_end.iloc[-2])} and is now {cr(yr_end.iloc[-1])}, {pc(yr_end.iloc[-1] / yr_end.iloc[-2] - 1)} year to date." if len(yr_end) > 1 else ""],
        flushes=[f"There have been {len(flush)} margin flushes (the book falling 3% or more within a week) since {dd(dates[0])}."
                 + (f" The deepest took {pc(min(f['drop'] for f in flush))} off the book." if flush else ""),
                 (f"The book took a median of {int(np.median([f['days_to_recover'] for f in fl_rec]))} days to regain its prior peak." if fl_rec else "")
                 + (f" {len(flush) - len(fl_rec)} flush{'es have' if len(flush) - len(fl_rec) != 1 else ' has'} not recovered yet." if len(flush) > len(fl_rec) else "")],
    )
    dump("flows.json", flows)

    # ================================================================ COMPOSITION (latest)
    lt = pd.DataFrame({"amt": amt.loc[T]})
    lt = lt[lt["amt"] > 0]
    lt["sector"] = sec.reindex(lt.index)
    lt["amt20"] = amt.shift(20).loc[T].reindex(lt.index)
    lt["amt250"] = amt.shift(250).loc[T].reindex(lt.index) if len(dates) > 250 else np.nan
    lt["adv"] = adv20.loc[T].reindex(lt.index)
    lt["mcap"] = latest_mcap.reindex(lt.index) if latest_mcap is not None else np.nan
    lt["type"] = grp_type.reindex(lt.index)
    lt["cap"] = cap_class.loc[T].reindex(lt.index)
    lt["tier"] = tier.loc[T].reindex(lt.index)

    def bucket(series, edges, labels):
        return pd.cut(series, edges, labels=labels, right=False)

    fb = bucket(lt["amt"], [0, 1, 10, 50, 100, 500, np.inf], ["Under ₹1 cr", "₹1-10 cr", "₹10-50 cr", "₹50-100 cr", "₹100-500 cr", "₹500 cr+"])
    mb = bucket(lt["mcap"], [0, 500, 2000, 10000, 50000, 200000, np.inf], ["Under ₹500 cr", "₹500-2,000 cr", "₹2,000-10,000 cr", "₹10,000-50,000 cr", "₹50,000 cr-2 lakh cr", "₹2 lakh cr+"])
    lb = bucket(lt["adv"], [0, 1, 10, 50, 200, np.inf], ["Under ₹1 cr/day", "₹1-10 cr/day", "₹10-50 cr/day", "₹50-200 cr/day", "₹200 cr+/day"])

    def table(keys):
        g = lt.groupby(keys, observed=True).agg(amt=("amt", "sum"), amt20=("amt20", "sum"), amt250=("amt250", "sum"), n=("amt", "size"))
        g = g[g["amt"] > 0]
        return [dict(group=str(k), amt=rnd(v.amt), share=rnd(v.amt / tot, 4), ch20=rnd(v.amt / v.amt20 - 1, 4) if v.amt20 else None,
                     ch1y=rnd(v.amt / v.amt250 - 1, 4) if v.amt250 else None, n=int(v.n)) for k, v in g.iterrows()]

    sec_tab = sorted(table("sector"), key=lambda r: -r["amt"])
    top_by_sec = {s: [dict(symbol=i, amt=rnd(a)) for i, a in lt[lt["sector"] == s]["amt"].nlargest(5).items()] for s in lt["sector"].unique()}
    for r_ in sec_tab:
        r_["top"] = top_by_sec.get(r_["group"], [])
    comp = dict(sector=sec_tab, funding=table(fb), mcap=table(mb), liquidity=table(lb), cap=table("cap"), tier=table("tier"), type=table("type"))
    fast = max((r_ for r_ in sec_tab if r_["amt"] > 0.01 * tot and r_["ch20"] is not None), key=lambda r_: r_["ch20"], default=None)
    slow = min((r_ for r_ in sec_tab if r_["amt"] > 0.01 * tot and r_["ch20"] is not None), key=lambda r_: r_["ch20"], default=None)
    fund = comp["funding"]
    big = sum(r_["amt"] for r_ in fund if r_["group"] in ("₹100-500 cr", "₹500 cr+"))
    big_n = sum(r_["n"] for r_ in fund if r_["group"] in ("₹100-500 cr", "₹500 cr+"))
    thin = [r_ for r_ in comp["liquidity"] if r_["group"] in ("Under ₹1 cr/day", "₹1-10 cr/day")]
    comp["insights"] = dict(
        sector=[f"{sec_tab[0]['group']} carries the most margin money at {cr(sec_tab[0]['amt'])} ({pc(sec_tab[0]['share'], sign=False)} of the book).",
                (f"Over 20 trading days {fast['group']} saw the fastest build ({pc(fast['ch20'])}) and {slow['group']} the sharpest cut ({pc(slow['ch20'])})." if fast and slow else "")],
        funding=[f"Just {big_n} stocks have ₹100 cr or more funded, yet they hold {pc(big / tot, sign=False)} of the book.",
                 f"{sum(r_['n'] for r_ in fund if r_['group'] == 'Under ₹1 cr')} stocks have under ₹1 cr funded: a long tail of small positions."],
        mcap=[f"Companies worth under ₹2,000 cr hold {pc(sum(r_['amt'] for r_ in comp['mcap'] if r_['group'] in ('Under ₹500 cr', '₹500-2,000 cr')) / tot, sign=False)} of the book.",
              "Margin in small companies is the riskiest kind: their prices move more and their trading is thinner."],
        liquidity=[f"{sum(r_['n'] for r_ in thin)} stocks trade under ₹10 cr a day on average but still carry {cr(sum(r_['amt'] for r_ in thin))} of margin.",
                   "That money would take the longest to unwind in a sell-off."],
    )
    dump("composition.json", comp)

    # ================================================================ STOCKS (latest table)
    univ_now = lt.index
    lagged = {k: (amt.iloc[-1 - k].reindex(univ_now) if len(dates) > k else pd.Series(np.nan, index=univ_now)) for k in (1, 5, 21, 63, 250)}
    def at(df, k):
        return lagged[k]
    r21_now = ret(21).loc[T]
    dtu_now, adv_now, dp_now, z_now, px_now = dtu.loc[T], adv20.loc[T], dpct.loc[T], z.loc[T], close.loc[T]
    pct1y = amt.tail(250).rank(pct=True).loc[T].reindex(univ_now)
    rows = []
    for s in univ_now:
        a = lt.at[s, "amt"]
        rows.append(dict(
            s=s, n=names.get(s, s).title()[:40], sec=lt.at[s, "sector"], cap=lt.at[s, "cap"], t=lt.at[s, "type"],
            a=rnd(a), sh=rnd(a / tot, 5),
            c1=rnd(a - at(amt, 1)[s]), c5=rnd(a - at(amt, 5)[s]), c21=rnd(a - at(amt, 21)[s]), c63=rnd(a - at(amt, 63)[s]), c250=rnd(a - at(amt, 250)[s]),
            p1=rnd(a / at(amt, 1)[s] - 1, 4) if at(amt, 1)[s] else None, p5=rnd(a / at(amt, 5)[s] - 1, 4) if at(amt, 5)[s] else None,
            p21=rnd(a / at(amt, 21)[s] - 1, 4) if at(amt, 21)[s] else None, p63=rnd(a / at(amt, 63)[s] - 1, 4) if at(amt, 63)[s] else None,
            p250=rnd(a / at(amt, 250)[s] - 1, 4) if at(amt, 250)[s] else None,
            mc=rnd(lt.at[s, "mcap"], 0), lev=rnd(a / lt.at[s, "mcap"], 5) if lt.at[s, "mcap"] and lt.at[s, "mcap"] > 0 else None,
            dtu=rnd(dtu_now[s], 1), adv=rnd(adv_now[s], 1), dp=rnd(dp_now[s], 3), z=rnd(z_now[s], 2),
            r21=rnd(r21_now[s], 4), px=rnd(px_now[s], 2), pr=rnd(pct1y.get(s), 3)))
    rows.sort(key=lambda r_: -r_["a"])
    dump("stocks.json", rows)
    st_df = pd.DataFrame(rows).set_index("s")
    lev_ok = st_df[(st_df["mc"] >= 500) & st_df["lev"].notna()].sort_values("lev", ascending=False)
    crowd_ok = st_df[(st_df["a"] >= 10) & st_df["dtu"].notna()].sort_values("dtu", ascending=False)
    unusual = st_df[(st_df["a"] >= 5) & st_df["z"].notna()]
    unusual = unusual.reindex(unusual["z"].abs().sort_values(ascending=False).index)
    gain = st_df.sort_values("c21", ascending=False)
    loss = st_df.sort_values("c21")
    stock_ins = dict(
        leveraged=[f"{lev_ok.index[0]} has the most margin relative to its size: {pc(lev_ok['lev'].iloc[0], 2, False)} of its market value is funded by brokers." if len(lev_ok) else "",
                   f"{(lev_ok['lev'] >= 0.02).sum()} stocks worth ₹500 cr or more have 2% or more of their market value on margin. That share is far higher as a share of the free float, since promoters rarely trade."],
        crowded=[f"{crowd_ok.index[0]} would need {crowd_ok['dtu'].iloc[0]:.0f} days of normal delivery buying to absorb its margin book of {cr(crowd_ok['a'].iloc[0])}." if len(crowd_ok) else "",
                 f"{(crowd_ok['dtu'] >= 20).sum()} stocks with ₹10 cr or more funded need 20 days or more. A margin call there meets very few natural buyers."],
        unusual=[f"{unusual.index[0]} had the most unusual book move today, {abs(unusual['z'].iloc[0]):.1f} times its normal daily swing ({'up' if unusual['z'].iloc[0] > 0 else 'down'} {cr(abs(unusual['c1'].iloc[0]))})." if len(unusual) else "",
                 "Big one-day jumps often come before news, results or a block deal. Big drops usually mean margin calls or profit taking."],
        movers=[f"Over 21 trading days the biggest build was in {gain.index[0]} ({cr(gain['c21'].iloc[0])} added) and the biggest cut in {loss.index[0]} ({cr(abs(loss['c21'].iloc[0]))} removed).",
                f"{(st_df['c21'] > 0).sum()} stocks saw margin added over the month and {(st_df['c21'] < 0).sum()} saw it cut."],
    )
    dump("stock_insights.json", stock_ins)

    # ================================================================ SMART MONEY (forward returns)
    univ = (adv20 >= MIN_ADV_CR) & (amt >= MIN_MTF_CR) & (close >= MIN_PRICE)
    g20 = (amt / amt.shift(20) - 1).where(univ & (amt.shift(20) > 0))
    smart = {"horizons": {}}
    for h, lab in ((5, "1W"), (21, "1M"), (63, "3M")):
        jump_ahead = P["jump"][::-1].rolling(h, min_periods=1).max()[::-1].shift(-1).fillna(0).astype(bool)
        fwd = (adj.shift(-h) / adj - 1).where(~jump_ahead)
        valid = g20.notna() & fwd.notna()
        base = fwd.where(valid).mean(axis=1)
        ex = fwd.sub(base, axis=0)
        q = g20.where(valid).rank(axis=1, pct=True).apply(np.ceil, args=()) if False else np.ceil(g20.where(valid).rank(axis=1, pct=True) * 5)
        rows_q = []
        for k in range(1, 6):
            e = ex.where(q == k).mean(axis=1).dropna()
            f = fwd.where(q == k).mean(axis=1).dropna()
            rows_q.append(dict(q=k, avg_fwd=rnd(f.mean(), 4), avg_excess=rnd(e.mean(), 4), days=int(e.size)))
        # spread by year: biggest builders minus biggest cutters
        top = ex.where(q == 5).mean(axis=1)
        bot = ex.where(q == 1).mean(axis=1)
        spread = (top - bot).dropna()
        cnt = spread.groupby(spread.index.year).size()
        by_year = spread.groupby(spread.index.year).mean()[cnt >= 40]   # skip part-years
        # heavily margined vs market value: top decile of margin / market value
        heavy = []
        if mtf_mcap is not None:
            lv = mtf_mcap.where(valid)
            dec = np.ceil(lv.rank(axis=1, pct=True) * 10)
            heavy = [rnd(ex.where(dec == 10).mean(axis=1).mean(), 4), rnd(ex.where(dec <= 5).mean(axis=1).mean(), 4)]
        smart["horizons"][lab] = dict(days=h, quintiles=rows_q, by_year=[dict(year=int(y), spread=rnd(v, 4)) for y, v in by_year.items()],
                                      heavy=heavy, hit=rnd((spread > 0).mean(), 3))
    h1 = smart["horizons"]["1M"]
    qq = h1["quintiles"]
    good_years = sum(1 for y in h1["by_year"] if y["spread"] and y["spread"] > 0)
    smart["insights"] = [
        f"Over the next month, stocks where margin grew most beat the universe by {pc(qq[4]['avg_excess'], 2)} on average; stocks where margin was cut most returned {pc(qq[0]['avg_excess'], 2)} versus the universe.",
        ("The gap is too small to matter: on average, where margin money moves tells you little about what the stock does next." if abs(qq[4]["avg_excess"] - qq[0]["avg_excess"]) < 0.002 else
         "So far margin buyers have, on average, been leaning the right way, though the edge is small." if qq[4]["avg_excess"] > qq[0]["avg_excess"] else
         "So far margin buyers have, on average, been leaning the wrong way."),
        f"That edge showed up in {good_years} of {len(h1['by_year'])} calendar years, and on {pc(h1['hit'], 0, False)} of days, so it is not reliable from one month to the next.",
        (f"Stocks with the most margin relative to their market value went on to return {pc(h1['heavy'][0], 2)} versus the universe over a month, compared with {pc(h1['heavy'][1], 2)} for the less-leveraged half." if h1["heavy"] else ""),
        "Returns are equal-weighted, before costs, across stocks with at least ₹10 cr funded and ₹10 cr of daily trading.",
    ]
    dump("smart.json", smart)

    # ================================================================ PER-STOCK FILES
    cut = T - pd.Timedelta(days=365)
    weekly_idx = dates[(dates < cut) & (dates.dayofweek == 4)]
    keep_idx = weekly_idx.append(dates[dates >= cut])
    active = amt.columns[(amt.tail(250) > 0).any()]
    nifty = idx.get("nifty500")
    for s in active:
        a = amt[s].reindex(keep_idx)
        c = adj[s].reindex(keep_idx)
        mc = mcap[s].reindex(keep_idx) if mcap is not None else None
        dt = dtu[s].reindex(keep_idx)
        first = a[a > 0].index.min()
        if first is None or pd.isna(first):
            continue
        sel = keep_idx[keep_idx >= first]
        obj = dict(s=s, n=names.get(s, s).title(), sec=sec.get(s, "Others"), t=grp_type.get(s, "Non-F&O"),
                   d=[x.strftime("%Y-%m-%d") for x in sel], a=[rnd(v) for v in a.reindex(sel)], c=[rnd(v) for v in c.reindex(sel)],
                   l=[rnd(v, 5) for v in (a / mc).reindex(sel)] if mc is not None else None,
                   u=[rnd(v, 1) for v in dt.reindex(sel)],
                   m=[rnd(v) for v in nifty.reindex(sel)] if nifty is not None else None)
        (OUT / "s" / f"{s.replace('/', '_')}.json").write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    dump("search.json", [[r_["s"], r_["n"]] for r_ in rows] + [[s, names.get(s, s).title()] for s in active if s not in st_df.index])
    built = datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ")
    dump("build.json", dict(asof=asof, built=built, days=len(dates), start=dates[0].strftime("%Y-%m-%d")))
    stamp_assets(built)
    print(f"built {asof}: {len(dates)} days from {dates[0]:%Y-%m-%d}, {len(rows)} stocks, {len(active)} stock files")
    for k, v in ov.items():
        if k == "insights":
            for i in v:
                print("  -", i)


if __name__ == "__main__":
    main()
