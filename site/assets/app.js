/* RECO MTF Lens Analyzer: a small hash-routed app over the JSON built by pipeline/build.py */
(() => {
  'use strict';
  const app = document.getElementById('app');
  let VER = '';
  const cache = {};
  const load = (f) => (cache[f] ||= fetch(`data/${f}?v=${VER}`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); }));

  // ------------------------------------------------------------ formatting
  const nIN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const nIN1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
  const nIN2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  const neg = (s) => s.replace('-', '−');
  const cr = (x) => {
    if (x == null || isNaN(x)) return 'n/a';
    const a = Math.abs(x), sgn = x < 0 ? '−' : '';
    if (a >= 1e5) return `${sgn}₹${(a / 1e5).toFixed(2)} lakh cr`;
    if (a >= 100) return `${sgn}₹${nIN.format(a)} cr`;
    return `${sgn}₹${nIN1.format(a)} cr`;
  };
  const crS = (x) => {  // short, for axes and tight tiles
    if (x == null || isNaN(x)) return '';
    const a = Math.abs(x), sgn = x < 0 ? '−' : '';
    if (a >= 1e5) return `${sgn}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L cr`;
    if (a >= 1e3) return `${sgn}₹${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K cr`;
    return `${sgn}₹${nIN.format(a)} cr`;
  };
  const pct = (x, d = 1, sign = true) => (x == null || isNaN(x) ? 'n/a' : neg((sign && x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%'));
  const signCr = (x) => (x == null ? 'n/a' : (x > 0 ? '+' : '') + cr(x));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };
  const ord = (n) => { const v = Math.round(n), t = v % 100; return v + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')); };
  const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
                  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };

  // ------------------------------------------------------------ theme + charts
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let charts = [];
  const C = () => ({ c1: css('--c1'), c2: css('--c2'), c3: css('--c3'), c4: css('--c4'), c5: css('--c5'), c6: css('--c6'), c7: css('--c7'),
    fg: css('--fg'), muted: css('--muted'), subtle: css('--subtle'), grid: css('--grid'), axis: css('--axis'), card: css('--card'),
    line: css('--line'), up: css('--up'), down: css('--down'), tint: css('--tint'), surface: css('--surface') });
  function mk(el, option) {
    const c = echarts.init(el, null, { renderer: 'canvas' });
    c.setOption(option);
    charts.push(c);
    return c;
  }
  function base(extra = {}) {
    const k = C();
    return {
      animationDuration: 500,
      textStyle: { fontFamily: css('--font'), color: k.muted },
      grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', backgroundColor: k.card, borderColor: k.line, textStyle: { color: k.fg, fontSize: 12 }, confine: true,
                 axisPointer: { type: 'line', lineStyle: { color: k.axis } } },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 4, textStyle: { color: k.muted, fontSize: 12 } },
      ...extra,
    };
  }
  const xCat = (data, extra = {}) => { const k = C(); return { type: 'category', data, boundaryGap: false, axisLine: { lineStyle: { color: k.axis } }, axisTick: { show: false },
    axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true }, ...extra }; };
  const yVal = (fmt, extra = {}) => { const k = C(); return { type: 'value', scale: true, splitLine: { lineStyle: { color: k.grid } }, axisLabel: { color: k.subtle, fontSize: 11, formatter: fmt }, ...extra }; };
  const dateLabel = (s) => { const [y, m] = s.split('-'); return `${MON[+m - 1]} ${y.slice(2)}`; };
  const area = (color) => ({ color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + '44' }, { offset: 1, color: color + '00' }]) });
  window.addEventListener('resize', () => charts.forEach((c) => c.resize()));

  // ------------------------------------------------------------ building blocks
  function insight(list) {
    const items = (list || []).filter(Boolean);
    if (!items.length) return '';
    return `<div class="insight"><span class="lbl">Insight</span><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  }
  function card({ id, title, note, ctl = '', body = '', chart = '', ins = [] }) {
    return `<section class="card" id="${id || ''}">
      <div class="card-h"><div><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}</div>${ctl ? `<div class="ctl">${ctl}</div>` : ''}</div>
      ${chart ? `<div class="chart ${chart}"></div>` : ''}${body}
      <div class="ins-slot">${insight(ins)}</div></section>`;
  }
  const seg = (name, opts, on) => `<div class="seg" role="group" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === on}">${l}</button>`).join('')}</div>`;
  function onSeg(root, name, fn) {
    const g = root.querySelector(`[data-seg="${name}"]`);
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      fn(b.dataset.v);
    });
  }
  const setIns = (sec, list) => { sec.querySelector('.ins-slot').innerHTML = insight(list); };
  const symLink = (s, n) => `<a class="sym" href="#stock/${encodeURIComponent(s)}">${esc(s)}</a>${n ? `<span class="nm">${esc(n)}</span>` : ''}`;
  const lastIdx = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; };
  function sliceRange(dates, range) {
    if (range === 'ALL') return 0;
    const n = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '3Y': 1096 }[range];
    const end = new Date(dates[dates.length - 1]); end.setDate(end.getDate() - n);
    const iso = end.toISOString().slice(0, 10);
    const i = dates.findIndex((d) => d >= iso);
    return Math.max(0, i);
  }
  const rangeSeg = (on = '1Y') => seg('range', [['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1Y'], ['3Y', '3Y'], ['ALL', 'All']], on);
  function bars(el, cats, vals, opt = {}) {
    const k = C();
    return mk(el, base({
      grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
      tooltip: { ...base().tooltip, axisPointer: { type: 'shadow' }, valueFormatter: opt.fmt || crS },
      xAxis: opt.horizontal ? yVal(opt.fmt || crS, { scale: false }) : { ...xCat(cats), boundaryGap: true },
      yAxis: opt.horizontal ? { type: 'category', data: cats, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: k.muted, fontSize: 12 } } : yVal(opt.fmt || crS, { scale: false }),
      series: [{ type: 'bar', data: vals.map((v) => ({ value: v, itemStyle: { color: opt.color ? opt.color(v) : (v >= 0 ? k.c1 : k.c7), borderRadius: opt.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] } })),
                 barMaxWidth: 28, label: opt.label ? { show: true, position: opt.horizontal ? 'right' : 'top', color: k.muted, fontSize: 11, formatter: (p) => (opt.fmt || crS)(p.value) } : undefined }],
    }));
  }

  // ------------------------------------------------------------ OVERVIEW
  async function overview() {
    const [ov, ts, fl, ctx] = await Promise.all([load('overview.json'), load('timeseries.json'), load('flows.json'), load('context.json')]);
    const ch = ov.changes;
    const tile = (k, v, s, t = '') => `<div class="ht"><span class="k">${k}</span><span class="v ${t}">${v}</span><span class="s">${s}</span></div>`;
    const kv = (k, v, s, t = '') => `<div class="kv"><span class="k">${k}</span><span class="v ${t}">${v}</span><span class="s">${s}</span></div>`;
    const chg = (lbl, c) => c ? kv(`${lbl} change`, `<span class="${tone(c.abs)}">${signCr(c.abs)}</span>`, `${pct(c.pct)} vs ${day(c.ref_date)} (${crS(c.ref)})`) : '';
    const tot = ov.fo + ov.nonfo + ov.etf;
    // momentum read for the trend group
    const ann90 = ch['90D'] ? Math.pow(1 + ch['90D'].pct, 4) - 1 : null;
    const trendIns = ch['1Y'] && ann90 != null ? [ann90 > ch['1Y'].pct
      ? `The last 90 days annualise to ${pct(ann90, 0)}, faster than the ${pct(ch['1Y'].pct, 0)} pace of the past year. Leverage growth is speeding up.`
      : `The last 90 days annualise to ${pct(ann90, 0)}, slower than the ${pct(ch['1Y'].pct, 0)} pace of the past year. Leverage growth is cooling.`] : [];
    app.innerHTML = `
      <section class="hero">
        <span class="eyebrow">NSE margin trading book · data as of ${day(ov.asof)}</span>
        <div><h1>${cr(ov.book)} <span class="delta ${tone(ov.d1)}">${pct(ov.d1, 2)} on the day</span></h1>
        <p class="sub">${nIN.format(ov.securities)} securities funded · history since ${day(ov.history_start)} · ${nIN.format(ov.days)} trading days</p></div>
        <ul class="read">${ov.insights.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="hero-tiles">
          ${tile('New positions', cr(ov.fresh), `${pct(ov.fresh / ov.fresh_prev - 1)} vs previous day`)}
          ${tile('Positions closed', cr(ov.closed), `${pct(ov.closed / ov.closed_prev - 1)} vs previous day`)}
          ${tile('Net daily flow', signCr(ov.net), 'New minus closed', tone(ov.net))}
          ${tile('Average net flow, 30 days', signCr(ov.net30), 'Per trading day', tone(ov.net30))}
        </div>
      </section>
      <div class="kgroups">
        <div class="kg"><h3>Trend</h3>${chg('30-day', ch['30D'])}${chg('90-day', ch['90D'])}${chg('6-month', ch['6M'])}${chg('1-year', ch['1Y'])}${chg('3-year', ch['3Y'])}${insight(trendIns)}</div>
        <div class="kg"><h3>Records</h3>
          ${kv('All-time high', cr(ov.ath), `${day(ov.ath_date)} · ${ov.ath_days ? ov.ath_days + ' days ago' : 'today'}`)}
          ${kv('7-day average book', cr(ov.avg7), 'Trailing 7 trading days')}
          ${kv('Biggest inflow day', `<span class="up">${signCr(ov.max_in)}</span>`, day(ov.max_in_date))}
          ${kv('Biggest outflow day', `<span class="down">${signCr(ov.max_out)}</span>`, day(ov.max_out_date))}
          ${insight([ov.book >= ov.ath ? 'The book closed at a record today.' : `Today the book sits ${pct(1 - ov.book / ov.ath, 1, false)} below its record. ${ov.ath_days <= 30 ? 'The peak is recent, so leverage is still near its highs.' : `The peak is ${ov.ath_days} days old.`}`])}</div>
        <div class="kg"><h3>Concentration</h3>
          ${kv('Top stock share', pct(ov.top_share, 1, false), `${esc(ov.top_stock)} (${cr(ov.top_stock_amt)})`)}
          ${kv('Top 10 share', pct(ov.top10_share, 1, false), `${cr(ov.top10_amt)} of the book`)}
          ${kv('F&O share', pct(ov.fo / tot, 1, false), `Non-F&O ${pct(ov.nonfo / tot, 1, false)} · ETF ${pct(ov.etf / tot, 1, false)}`)}
          ${kv('Half the book', `Top ${ov.half_n}`, `stocks hold 50% (${cr(ov.half_amt)})`)}
          ${insight([`No single stock dominates: even the largest, ${ov.top_stock}, is ${pct(ov.top_share, 1, false)} of the book. Risk sits in the breadth of small positions, not a few big ones.`])}</div>
      </div>
      ${card({ id: 'c-main', title: 'MTF book against the market', note: 'Total NSE margin book with the Nifty 500 on the right axis.', ctl: seg('metric', [['book', 'Book'], ['securities', 'Securities'], ['fresh', 'New positions'], ['closed', 'Closed']], 'book') + rangeSeg('1Y'), chart: 'lg' })}
      <div class="grid">
        ${card({ id: 'c-prog', title: 'Book progression', note: 'Book at the end of each period.', ctl: seg('per', [['W', 'Weekly'], ['M', 'Monthly'], ['Y', 'Yearly']], 'M'), chart: '', ins: fl.insights.year_end })}
        ${card({ id: 'c-stress-mini', title: 'Leverage Stress Index', note: 'How hard a forced unwind would hit today, 0 to 100.', chart: 'sm', ins: ctx.stress.slice(0, 2), body: '<p class="note"><a href="#risk">See the full risk dashboard</a></p>' })}
      </div>
      ${card({ id: 'c-cal', title: 'Daily activity, last 53 weeks', note: 'Net flow each trading day. Green is net new margin buying, red is net selling.', chart: 'cal', ins: fl.insights.calendar })}
    `;
    // main chart
    const sec = document.getElementById('c-main');
    const el = sec.querySelector('.chart');
    let metric = 'book', range = '1Y';
    const draw = () => {
      const i0 = sliceRange(ts.dates, range);
      const d = ts.dates.slice(i0), k = C();
      const m = ts[metric].slice(i0), nf = ts.nifty500.slice(i0);
      const lab = { book: 'MTF book', securities: 'Securities funded', fresh: 'New positions', closed: 'Positions closed' }[metric];
      const fmt = metric === 'securities' ? (v) => nIN.format(v) : crS;
      const c = charts.find((x) => x.getDom() === el); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
      mk(el, base({
        tooltip: { ...base().tooltip, formatter: (ps) => `<b>${day(ps[0].axisValue)}</b><br>` + ps.map((p) => `${p.marker}${p.seriesName}: ${p.seriesIndex === 0 ? fmt(p.value) : nIN2.format(p.value)}`).join('<br>') },
        xAxis: xCat(d, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
        yAxis: [yVal(fmt), yVal((v) => nIN.format(v), { splitLine: { show: false } })],
        dataZoom: [{ type: 'inside' }],
        series: [
          { name: lab, type: metric === 'fresh' || metric === 'closed' ? 'bar' : 'line', data: m, showSymbol: false, lineStyle: { width: 2, color: k.c1 }, itemStyle: { color: k.c1 }, areaStyle: metric === 'book' ? area(k.c1) : undefined, barMaxWidth: 6 },
          { name: 'Nifty 500', type: 'line', yAxisIndex: 1, data: nf, showSymbol: false, lineStyle: { width: 1.5, color: k.c5 }, itemStyle: { color: k.c5 } },
        ],
      }));
      const a = m.find((v) => v != null), b = m[lastIdx(m)], na = nf.find((v) => v != null), nb = nf[lastIdx(nf)];
      const list = [];
      if (metric === 'book' && a && na) {
        const g = b / a - 1, ng = nb / na - 1;
        list.push(`Over this window the book moved ${pct(g)} and the Nifty 500 ${pct(ng)}.`);
        list.push(g > ng + 0.05 ? 'Margin money grew faster than prices, so leverage per rupee of market value went up.' :
          g < ng - 0.05 ? 'Prices rose faster than margin money, so the market leaned less on leverage over this window.' :
          'Margin money and prices moved roughly together.');
        // correlation of daily changes
        const dm = [], dn = [];
        for (let i = 1; i < m.length; i++) if (m[i] && m[i - 1] && nf[i] && nf[i - 1]) { dm.push(m[i] / m[i - 1] - 1); dn.push(nf[i] / nf[i - 1] - 1); }
        if (dm.length > 20) {
          const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length, ma = mean(dm), mb = mean(dn);
          let sab = 0, saa = 0, sbb = 0; dm.forEach((v, i) => { sab += (v - ma) * (dn[i] - mb); saa += (v - ma) ** 2; sbb += (dn[i] - mb) ** 2; });
          const r = sab / Math.sqrt(saa * sbb);
          list.push(`Day to day, book changes and market returns have a correlation of ${r.toFixed(2)}: ${r > 0.4 ? 'margin traders mostly add on up days and cut on down days.' : r > 0.15 ? 'a loose link; margin money only partly follows the market.' : 'almost no link, so margin flows move on their own.'}`);
        }
      } else if (metric === 'securities' && a) {
        list.push(`The number of stocks with any margin funding went from ${nIN.format(a)} to ${nIN.format(b)} over this window.`);
        list.push(b > a ? 'Brokers are funding a wider set of stocks, which spreads leverage into thinner names.' : 'Margin funding is concentrating into fewer stocks.');
      } else if (a) {
        const avg = m.filter((v) => v != null).reduce((s, v) => s + v, 0) / m.filter((v) => v != null).length;
        list.push(`${lab} averaged ${cr(avg)} a day over this window; the latest day was ${cr(b)}, ${pct(b / avg - 1)} against that average.`);
      }
      setIns(sec, list);
    };
    draw();
    onSeg(sec, 'metric', (v) => { metric = v; draw(); });
    onSeg(sec, 'range', (v) => { range = v; draw(); });

    // progression
    const ps = document.getElementById('c-prog'); const pel = h('<div class="chart sm"></div>'); ps.insertBefore(pel, ps.querySelector('.ins-slot'));
    const prog = (per) => {
      const out = new Map();
      ts.dates.forEach((d, i) => { if (ts.book[i] == null) return; const key = per === 'Y' ? d.slice(0, 4) : per === 'M' ? d.slice(0, 7) : weekKey(d); out.set(key, ts.book[i]); });
      let ks = [...out.keys()]; if (per === 'W') ks = ks.slice(-52); if (per === 'M') ks = ks.slice(-36);
      const c = charts.find((x) => x.getDom() === pel); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
      const k = C();
      bars(pel, ks.map((x) => per === 'M' ? dateLabel(x + '-01') : x), ks.map((x) => out.get(x)), { color: () => k.c1 });
    };
    const weekKey = (d) => { const t = new Date(d); const day0 = (t.getDay() + 2) % 7; t.setDate(t.getDate() - day0 + 4); return t.toISOString().slice(0, 10); };
    prog('M'); onSeg(ps, 'per', prog);

    gauge(document.querySelector('#c-stress-mini .chart'), ov.stress);
    calendar(document.querySelector('#c-cal .chart'), fl.calendar);
  }

  function gauge(el, v) {
    const k = C();
    mk(el, {
      series: [{ type: 'gauge', startAngle: 200, endAngle: -20, min: 0, max: 100, radius: '95%', center: ['50%', '62%'],
        axisLine: { lineStyle: { width: 14, color: [[0.3, k.c1], [0.7, k.c4], [1, k.c7]] } },
        pointer: { length: '58%', width: 5, itemStyle: { color: k.fg } }, anchor: { show: true, size: 10, itemStyle: { color: k.fg } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { color: k.subtle, distance: -36, fontSize: 11, formatter: (x) => ([0, 30, 70, 100].includes(x) ? x : '') },
        detail: { valueAnimation: true, offsetCenter: [0, '38%'], fontSize: 30, fontWeight: 500, color: k.fg, formatter: (x) => `${Math.round(x)}` },
        title: { offsetCenter: [0, '68%'], color: k.subtle, fontSize: 12 },
        data: [{ value: v ?? 0, name: v >= 70 ? 'Elevated' : v <= 30 ? 'Calm' : 'Moderate' }] }],
    });
  }

  function calendar(el, rows) {
    const k = C();
    const vals = rows.map((r) => Math.abs(r[1] || 0)).sort((a, b) => a - b);
    const cap = vals[Math.floor(vals.length * 0.95)] || 1;
    mk(el, {
      tooltip: { backgroundColor: k.card, borderColor: k.line, textStyle: { color: k.fg, fontSize: 12 }, formatter: (p) => `<b>${day(p.value[0])}</b><br>Net flow ${signCr(p.value[1])}` },
      visualMap: { show: false, min: -cap, max: cap, inRange: { color: [k.c7, k.surface, k.c1] } },
      calendar: { range: [rows[0][0], rows[rows.length - 1][0]], top: 22, left: 34, right: 8, bottom: 4, cellSize: ['auto', 'auto'],
        itemStyle: { borderColor: k.card, borderWidth: 2, color: k.surface }, splitLine: { show: false },
        dayLabel: { color: k.subtle, fontSize: 10, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] }, monthLabel: { color: k.subtle, fontSize: 10 }, yearLabel: { show: false } },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: rows }],
    });
  }

  // ------------------------------------------------------------ FLOWS
  async function flows() {
    const [fl, ts] = await Promise.all([load('flows.json'), load('timeseries.json')]);
    const I = fl.insights;
    app.innerHTML = `
      <div class="ph"><h1>Flows</h1><p>Where margin money comes in and goes out: by week, by month, by weekday, and the sharp unwinds the market calls flushes.</p></div>
      ${card({ id: 'f-time', title: 'Net flow over time', note: 'New positions minus positions closed. Monthly view adds the flow as a share of the month-start book.', ctl: seg('per', [['W', 'Weekly'], ['M', 'Monthly']], 'M'), chart: 'lg', ins: I.over_time })}
      <div class="grid three">
        ${card({ id: 'f-wd', title: 'Net flow by weekday', note: 'Average daily net flow, full history.', chart: 'sm', ins: I.weekday })}
        ${card({ id: 'f-mo', title: 'Net flow by month', note: 'Average daily net flow, full history.', chart: 'sm', ins: I.month })}
        ${card({ id: 'f-dom', title: 'Net flow by day of month', note: 'Average daily net flow, full history.', chart: 'sm', ins: I.dom })}
      </div>
      ${card({ id: 'f-flush', title: 'Margin flushes', note: 'Episodes where the book fell 3% or more within five trading days, shaded on the book.', chart: 'lg', ins: I.flushes,
        body: `<div class="tbox"><table><thead><tr><th>Peak</th><th>Low</th><th class="n">Book fall</th><th class="n">Amount</th><th class="n">Nifty 500 over the same days</th><th>Back to peak</th></tr></thead><tbody>${
          fl.flushes.slice().reverse().map((f) => `<tr><td>${day(f.start)}</td><td>${day(f.low)}</td><td class="n down">${pct(f.drop)}</td><td class="n">${cr(f.drop_cr)}</td><td class="n ${tone(f.nifty500)}">${pct(f.nifty500)}</td><td>${f.recovered ? `${day(f.recovered)} (${f.days_to_recover} days)` : '<span class="pill y">Not yet</span>'}</td></tr>`).join('')}</tbody></table></div>` })}
    `;
    const k = C();
    const tsec = document.getElementById('f-time'), tel = tsec.querySelector('.chart');
    const drawT = (per) => {
      const c = charts.find((x) => x.getDom() === tel); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
      if (per === 'W') { bars(tel, fl.weekly.dates.map(day), fl.weekly.net); return; }
      mk(tel, base({
        tooltip: { ...base().tooltip, axisPointer: { type: 'shadow' }, formatter: (ps) => `<b>${ps[0].axisValue}</b><br>` + ps.map((p) => `${p.marker}${p.seriesName}: ${p.seriesIndex ? pct(p.value) : signCr(p.value)}`).join('<br>') },
        xAxis: { ...xCat(fl.monthly.dates.map((d) => dateLabel(d + '-01'))), boundaryGap: true },
        yAxis: [yVal(crS, { scale: false }), yVal((v) => pct(v, 0), { scale: false, splitLine: { show: false } })],
        series: [{ name: 'Net flow', type: 'bar', data: fl.monthly.net.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? k.c1 : k.c7, borderRadius: 3 } })), barMaxWidth: 18 },
                 { name: '% of month-start book', type: 'line', yAxisIndex: 1, data: fl.monthly.pct, showSymbol: false, lineStyle: { color: k.c2, width: 1.5 }, itemStyle: { color: k.c2 } }],
      }));
    };
    drawT('M'); onSeg(tsec, 'per', drawT);
    bars(document.querySelector('#f-wd .chart'), fl.weekday.map((r) => r.day.slice(0, 3)), fl.weekday.map((r) => r.avg), { label: true });
    bars(document.querySelector('#f-mo .chart'), fl.month.map((r) => r.month), fl.month.map((r) => r.avg));
    bars(document.querySelector('#f-dom .chart'), fl.dom.map((r) => r.day), fl.dom.map((r) => r.avg));
    // flush chart
    const fel = document.querySelector('#f-flush .chart');
    const pos = (d) => { let i = ts.dates.indexOf(d); return i < 0 ? ts.dates.findIndex((x) => x >= d) : i; };
    mk(fel, base({
      tooltip: { ...base().tooltip, valueFormatter: crS },
      xAxis: xCat(ts.dates, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
      yAxis: yVal(crS), dataZoom: [{ type: 'inside' }],
      series: [{ name: 'MTF book', type: 'line', data: ts.book, showSymbol: false, lineStyle: { width: 2, color: k.c1 }, itemStyle: { color: k.c1 },
        markArea: { silent: true, itemStyle: { color: k.c7 + '2a' }, data: fl.flushes.map((f) => [{ xAxis: ts.dates[pos(f.start)] }, { xAxis: ts.dates[pos(f.low)] }]) } }],
    }));
  }

  // ------------------------------------------------------------ COMPOSITION
  async function composition() {
    const [cp, ts, ctx] = await Promise.all([load('composition.json'), load('timeseries.json'), load('context.json')]);
    const I = cp.insights;
    const total = cp.sector.reduce((s, r) => s + r.amt, 0);
    const maxSh = Math.max(...cp.sector.map((r) => r.share));
    app.innerHTML = `
      <div class="ph"><h1>Composition</h1><p>What the margin book is made of: F&amp;O versus the rest, company size, sector, position size and liquidity.</p></div>
      ${card({ id: 'k-type', title: 'F&O vs non-F&O vs ETF', note: 'Margin book by whether the stock has a derivatives market.', ctl: seg('mode', [['share', 'Share'], ['amt', 'Amount']], 'share') + rangeSeg('ALL'), chart: '', ins: ctx.comp_type })}
      ${card({ id: 'k-cap', title: 'By company size', note: 'Cap class by market value rank, recomputed daily. Rank tier splits it further.', ctl: seg('grp', [['cap', 'Cap class'], ['tier', 'Rank tier']], 'cap') + seg('mode', [['share', 'Share'], ['amt', 'Amount']], 'share'), chart: '', ins: ctx.comp_cap })}
      ${card({ id: 'k-sec', title: 'By sector', note: 'Sector from the Nifty Total Market list; stocks outside it are grouped as Others.', chart: 'lg', ins: I.sector,
        body: `<div class="tbox"><table><thead><tr><th>Sector</th><th class="n">Book</th><th>Share</th><th class="n">20 days</th><th class="n">1 year</th><th class="n">Stocks</th><th>Largest positions</th></tr></thead><tbody>${
          cp.sector.map((r) => `<tr><td>${esc(r.group)}</td><td class="n">${cr(r.amt)}</td><td><span class="bar" style="width:${(r.share / maxSh) * 70}px"></span>${pct(r.share, 1, false)}</td><td class="n ${tone(r.ch20)}">${pct(r.ch20)}</td><td class="n ${tone(r.ch1y)}">${pct(r.ch1y, 0)}</td><td class="n">${r.n}</td><td>${r.top.map((t) => `<a class="sym" href="#stock/${encodeURIComponent(t.symbol)}">${esc(t.symbol)}</a>`).join(', ')}</td></tr>`).join('')}</tbody></table></div>` })}
      <div class="grid three">
        ${card({ id: 'k-fund', title: 'Stocks by funding bracket', note: 'Grouped by the amount financed in each stock today.', ctl: seg('m', [['n', 'Count'], ['amt', 'Amount']], 'amt'), chart: 'sm', ins: I.funding })}
        ${card({ id: 'k-mcap', title: 'Stocks by market cap', note: 'Funded stocks grouped by company market value.', ctl: seg('m', [['n', 'Count'], ['amt', 'Amount']], 'amt'), chart: 'sm', ins: I.mcap })}
        ${card({ id: 'k-liq', title: 'Stocks by liquidity', note: 'Grouped by average daily traded value, last 20 days.', ctl: seg('m', [['n', 'Count'], ['amt', 'Amount']], 'amt'), chart: 'sm', ins: I.liquidity })}
      </div>`;
    const k = C(), pal = [k.c1, k.c2, k.c3, k.c4, k.c5, k.c6, k.c7];
    function stacked(sec, groups, mode, range = 'ALL') {
      let el = sec.querySelector('.chart');
      if (!el) { el = h('<div class="chart lg"></div>'); sec.insertBefore(el, sec.querySelector('.ins-slot')); }
      const c = charts.find((x) => x.getDom() === el); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
      const i0 = sliceRange(ts.dates, range), d = ts.dates.slice(i0);
      const keys = Object.keys(groups);
      const tot = d.map((_, i) => keys.reduce((s, kk) => s + (groups[kk][i0 + i] || 0), 0));
      mk(el, base({
        tooltip: { ...base().tooltip, valueFormatter: mode === 'share' ? (v) => pct(v, 1, false) : crS },
        xAxis: xCat(d, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
        yAxis: yVal(mode === 'share' ? (v) => pct(v, 0, false) : crS, { scale: false, max: mode === 'share' ? 1 : null }),
        dataZoom: [{ type: 'inside' }],
        series: keys.map((kk, j) => ({ name: kk, type: 'line', stack: 't', showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: pal[j % pal.length], opacity: 0.85 }, itemStyle: { color: pal[j % pal.length] },
          data: d.map((_, i) => { const v = groups[kk][i0 + i]; return v == null ? null : mode === 'share' ? (tot[i] ? v / tot[i] : null) : v; }) })),
      }));
    }
    const ts1 = document.getElementById('k-type'); let tMode = 'share', tRange = 'ALL';
    stacked(ts1, ts.comp_type, tMode, tRange);
    onSeg(ts1, 'mode', (v) => { tMode = v; stacked(ts1, ts.comp_type, tMode, tRange); });
    onSeg(ts1, 'range', (v) => { tRange = v; stacked(ts1, ts.comp_type, tMode, tRange); });
    const cs = document.getElementById('k-cap'); let cg = 'cap', cm = 'share';
    const capGroups = () => (cg === 'cap' ? ts.comp_cap : ts.comp_tier);
    stacked(cs, capGroups(), cm);
    onSeg(cs, 'grp', (v) => { cg = v; stacked(cs, capGroups(), cm); });
    onSeg(cs, 'mode', (v) => { cm = v; stacked(cs, capGroups(), cm); });
    const top15 = cp.sector.slice(0, 15);
    bars(document.querySelector('#k-sec .chart'), top15.map((r) => r.group), top15.map((r) => r.amt), { horizontal: true, label: true, color: () => k.c1 });
    [['k-fund', cp.funding], ['k-mcap', cp.mcap], ['k-liq', cp.liquidity]].forEach(([id, rows]) => {
      const sec = document.getElementById(id), el = sec.querySelector('.chart');
      const drawB = (m) => {
        const c = charts.find((x) => x.getDom() === el); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
        bars(el, rows.map((r) => r.group.replace(/^Under /, '<')), rows.map((r) => r[m]), { horizontal: true, label: true, fmt: m === 'n' ? (v) => nIN.format(v) : crS, color: () => k.c1 });
      };
      drawB('amt'); onSeg(sec, 'm', drawB);
    });
    void total;
  }

  // ------------------------------------------------------------ RISK
  async function risk() {
    const [ts, ctx, ov, st, si] = await Promise.all([load('timeseries.json'), load('context.json'), load('overview.json'), load('stocks.json'), load('stock_insights.json')]);
    const lev = st.filter((r) => r.mc >= 500 && r.lev != null).sort((a, b) => b.lev - a.lev).slice(0, 25);
    const crowd = st.filter((r) => r.a >= 10 && r.dtu != null).sort((a, b) => b.dtu - a.dtu).slice(0, 25);
    const names = { leverage: 'Book vs market value', growth: '3-month book growth', footprint: 'Margin share of trading', crowding: 'Days to unwind' };
    // weighted crowding insight
    const cw = ts.crowding.filter((v) => v != null);
    const cwNow = cw[cw.length - 1], cwMed = cw.slice().sort((a, b) => a - b)[Math.floor(cw.length / 2)];
    app.innerHTML = `
      <div class="ph"><h1>Leverage &amp; risk</h1><p>How stretched the margin book is against market value, trading volume and history, and which stocks would be hardest to unwind.</p></div>
      ${card({ id: 'r-stress', title: 'Leverage Stress Index', note: 'One gauge of margin-unwind stress versus every day since December 2021.', ins: ctx.stress,
        body: `<div class="gauge-row"><div class="chart sm" id="r-g"></div><div class="comp-list">${Object.entries(ctx.stress_components).map(([kk, v]) =>
          `<div class="comp"><div class="top"><span>${names[kk]}</span><b>${Math.round((v || 0) * 100)}</b></div><div class="track"><i style="width:${(v || 0) * 100}%"></i></div></div>`).join('')}</div></div><div class="chart" id="r-sh"></div>` })}
      <div class="grid">
        ${card({ id: 'r-liq', title: 'MTF book vs market liquidity', note: 'The book divided by the cash market\'s 20-day average daily turnover.', chart: '', ins: ctx.liquidity })}
        ${card({ id: 'r-foot', title: 'MTF footprint on the market', note: 'New plus closed margin positions as a share of cash-market turnover, 20-day average.', chart: '', ins: ctx.footprint })}
        ${card({ id: 'r-mcap', title: 'MTF book as a share of market value', note: 'Book divided by the market value of all listed NSE equities.', chart: '', ins: ctx.mcap })}
        ${card({ id: 'r-crowd', title: 'How crowded is the book?', note: 'Book-weighted average days of delivery volume needed to unwind each stock\'s margin.', chart: '',
          ins: [`Today the average rupee of margin sits in a stock that needs ${cwNow?.toFixed(1)} days of normal delivery buying to absorb it, against a median of ${cwMed?.toFixed(1)} days since 2021.`,
                cwNow > cwMed * 1.15 ? 'Positions are more crowded than usual, so a sell-off would take longer to clear.' : cwNow < cwMed * 0.85 ? 'Positions are less crowded than usual.' : 'Crowding is close to its normal level.'] })}
      </div>
      <div class="grid">
        ${card({ id: 'r-lev', title: 'Most leveraged stocks', note: 'Margin book as a share of company market value, companies worth ₹500 cr or more.', ins: si.leveraged,
          body: `<div class="tbox"><table><thead><tr><th>Stock</th><th class="n">Book</th><th class="n">Market cap</th><th class="n">Book / market cap</th><th class="n">Days to unwind</th></tr></thead><tbody>${
            lev.map((r) => `<tr><td>${symLink(r.s)}</td><td class="n">${cr(r.a)}</td><td class="n">${crS(r.mc)}</td><td class="n">${pct(r.lev, 2, false)}</td><td class="n">${r.dtu ?? 'n/a'}</td></tr>`).join('')}</tbody></table></div>` })}
        ${card({ id: 'r-sq', title: 'Most crowded margin', note: 'Stocks with ₹10 cr or more funded, ranked by days of delivery volume needed to unwind.', ins: si.crowded,
          body: `<div class="tbox"><table><thead><tr><th>Stock</th><th class="n">Book</th><th class="n">Days to unwind</th><th class="n">Daily traded</th><th class="n">Delivery</th></tr></thead><tbody>${
            crowd.map((r) => `<tr><td>${symLink(r.s)}</td><td class="n">${cr(r.a)}</td><td class="n">${r.dtu}</td><td class="n">${cr(r.adv)}</td><td class="n">${pct(r.dp, 0, false)}</td></tr>`).join('')}</tbody></table></div>` })}
      </div>`;
    const k = C();
    gauge(document.getElementById('r-g'), ov.stress);
    const line = (id, data, fmt, color = k.c1, roll = 0) => {
      const sec = document.getElementById(id); let el = sec.querySelector('.chart');
      if (!el) { el = h('<div class="chart"></div>'); sec.insertBefore(el, sec.querySelector('.ins-slot')); }
      let v = data;
      if (roll) v = data.map((_, i) => { const w = data.slice(Math.max(0, i - roll + 1), i + 1).filter((x) => x != null); return w.length ? w.reduce((s, x) => s + x, 0) / w.length : null; });
      mk(el, base({ tooltip: { ...base().tooltip, valueFormatter: fmt }, xAxis: xCat(ts.dates, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
        yAxis: yVal(fmt), dataZoom: [{ type: 'inside' }],
        series: [{ type: 'line', data: v, showSymbol: false, lineStyle: { width: 2, color }, itemStyle: { color }, areaStyle: area(color) }] }));
    };
    const sh = document.getElementById('r-sh');
    mk(sh, base({ tooltip: { ...base().tooltip, valueFormatter: (v) => Math.round(v) }, xAxis: xCat(ts.dates, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
      yAxis: yVal((v) => v, { min: 0, max: 100, scale: false }), dataZoom: [{ type: 'inside' }],
      series: [{ name: 'Stress index', type: 'line', data: ts.stress, showSymbol: false, lineStyle: { width: 2, color: k.c2 }, itemStyle: { color: k.c2 },
        markArea: { silent: true, data: [[{ yAxis: 70, itemStyle: { color: k.c7 + '18' } }, { yAxis: 100 }], [{ yAxis: 0, itemStyle: { color: k.c1 + '14' } }, { yAxis: 30 }]] } }] }));
    line('r-liq', ts.book_days_turnover, (v) => `${(+v).toFixed(1)} days`);
    line('r-foot', ts.footprint, (v) => pct(v, 1, false), k.c2, 20);
    if (ts.book_pct_mcap) line('r-mcap', ts.book_pct_mcap, (v) => pct(v, 2, false), k.c3);
    line('r-crowd', ts.crowding, (v) => `${(+v).toFixed(1)} days`, k.c4);
  }

  // ------------------------------------------------------------ STOCKS
  async function stocks() {
    const [st, si] = await Promise.all([load('stocks.json'), load('stock_insights.json')]);
    const unusual = st.filter((r) => r.a >= 5 && r.z != null).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 20);
    app.innerHTML = `
      <div class="ph"><h1>Stocks</h1><p>Which stocks margin money is moving into and out of, and every funded stock in one sortable table.</p></div>
      ${card({ id: 's-rank', title: 'Stock rankings', note: 'Biggest margin builds and cuts over the chosen period.', ctl: seg('p', [['1', 'Daily'], ['5', 'Weekly'], ['21', 'Monthly'], ['63', 'Quarterly'], ['250', 'Yearly']], '21') + seg('u', [['c', '₹'], ['p', '%']], 'c'),
        body: '<div class="grid"><div><h3 style="font-size:14px;margin-bottom:8px">Biggest builds</h3><div class="tbox" id="s-up"></div></div><div><h3 style="font-size:14px;margin-bottom:8px">Biggest cuts</h3><div class="tbox" id="s-dn"></div></div></div>', ins: si.movers })}
      ${card({ id: 's-unu', title: 'Unusual margin activity today', note: 'Today\'s book move against each stock\'s own last 60 days. 3 or more is rare.', ins: si.unusual,
        body: `<div class="tbox"><table><thead><tr><th>Stock</th><th class="n">Move size</th><th class="n">Change today</th><th class="n">Book</th><th class="n">Price, 1 month</th></tr></thead><tbody>${
          unusual.map((r) => `<tr><td>${symLink(r.s, r.n)}</td><td class="n ${tone(r.z)}">${neg(r.z.toFixed(1))}</td><td class="n ${tone(r.c1)}">${signCr(r.c1)}</td><td class="n">${cr(r.a)}</td><td class="n ${tone(r.r21)}">${pct(r.r21)}</td></tr>`).join('')}</tbody></table></div>` })}
      ${card({ id: 's-all', title: 'Every funded stock', note: 'Click a header to sort, or a symbol to open its history.',
        body: `<div class="ctl"><div class="search"><input class="inp" id="s-q" type="search" placeholder="Search symbol, name or sector" aria-label="Search stocks"></div>
          <select class="inp" id="s-f" style="max-width:14rem" aria-label="Filter group"><option value="">All groups</option><option>F&amp;O</option><option>Non-F&amp;O</option><option>ETF</option><option>Large</option><option>Mid</option><option>Small</option><option>Micro</option></select></div>
          <div class="tbox" id="s-tab"></div><p class="note" id="s-cnt"></p>`, ins: [] })}`;
    const rankSec = document.getElementById('s-rank');
    let P = '21', U = 'c';
    const rk = () => {
      const key = (U === 'c' ? 'c' : 'p') + P;
      const pool = st.filter((r) => r[key] != null && (U === 'c' || r.a >= 5));
      const sorted = pool.slice().sort((a, b) => b[key] - a[key]);
      const tb = (rows) => `<table><thead><tr><th>Stock</th><th class="n">Change</th><th class="n">Book now</th><th class="n">Price, 1 month</th></tr></thead><tbody>${rows.map((r) =>
        `<tr><td>${symLink(r.s)}</td><td class="n ${tone(r[key])}">${U === 'c' ? signCr(r[key]) : pct(r[key])}</td><td class="n">${cr(r.a)}</td><td class="n ${tone(r.r21)}">${pct(r.r21)}</td></tr>`).join('')}</tbody></table>`;
      document.getElementById('s-up').innerHTML = tb(sorted.slice(0, 15));
      document.getElementById('s-dn').innerHTML = tb(sorted.slice(-15).reverse());
      const lbl = { 1: 'today', 5: 'this week', 21: 'this month', 63: 'this quarter', 250: 'this year' }[P];
      const ck = 'c' + P, adds = st.filter((r) => r[ck] > 0).length, cuts = st.filter((r) => r[ck] < 0).length;
      const upPx = st.filter((r) => r[ck] > 0 && r.r21 != null); const avgPx = upPx.length ? upPx.reduce((s, r) => s + r.r21, 0) / upPx.length : null;
      setIns(rankSec, [`${adds} stocks saw margin added ${lbl} and ${cuts} saw it cut.`,
        `The top build ${lbl} was ${sorted[0]?.s} (${U === 'c' ? signCr(sorted[0]?.[key]) : pct(sorted[0]?.[key])}); the deepest cut was ${sorted[sorted.length - 1]?.s} (${U === 'c' ? signCr(sorted[sorted.length - 1]?.[key]) : pct(sorted[sorted.length - 1]?.[key])}).`,
        U === 'p' ? 'Percentage moves only include stocks with ₹5 cr or more funded, so tiny books do not dominate.' : (avgPx != null ? `Stocks where margin was added moved ${pct(avgPx)} on average in price over the past month.` : '')]);
    };
    rk(); onSeg(rankSec, 'p', (v) => { P = v; rk(); }); onSeg(rankSec, 'u', (v) => { U = v; rk(); });
    // full table
    let sk = 'a', sd = -1;
    const cols = [['s', 'Stock'], ['sec', 'Sector'], ['cap', 'Size'], ['a', 'Book'], ['sh', 'Share'], ['c1', 'Today'], ['p21', '1 month'], ['p250', '1 year'], ['lev', 'Book / mcap'], ['dtu', 'Days to unwind'], ['dp', 'Delivery'], ['r21', 'Price 1M']];
    const tbl = () => {
      const q = document.getElementById('s-q').value.trim().toLowerCase(), f = document.getElementById('s-f').value;
      let rows = st.filter((r) => (!q || `${r.s} ${r.n} ${r.sec}`.toLowerCase().includes(q)) && (!f || r.t === f || r.cap === f));
      rows = rows.slice().sort((a, b) => { const x = a[sk], y = b[sk]; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sd; });
      const shown = rows.slice(0, 400);
      document.getElementById('s-tab').innerHTML = `<table><thead><tr>${cols.map(([kk, l]) => `<th class="${['s', 'sec', 'cap'].includes(kk) ? '' : 'n'}" aria-sort="${kk === sk ? (sd > 0 ? 'ascending' : 'descending') : 'none'}"><button data-k="${kk}">${l}</button></th>`).join('')}</tr></thead><tbody>${shown.map((r) =>
        `<tr><td>${symLink(r.s)}</td><td>${esc(r.sec)}</td><td>${esc(r.cap)}</td><td class="n">${cr(r.a)}</td><td class="n">${pct(r.sh, 2, false)}</td><td class="n ${tone(r.c1)}">${signCr(r.c1)}</td><td class="n ${tone(r.p21)}">${pct(r.p21)}</td><td class="n ${tone(r.p250)}">${pct(r.p250, 0)}</td><td class="n">${pct(r.lev, 2, false)}</td><td class="n">${r.dtu ?? 'n/a'}</td><td class="n">${pct(r.dp, 0, false)}</td><td class="n ${tone(r.r21)}">${pct(r.r21)}</td></tr>`).join('')}</tbody></table>`;
      document.getElementById('s-cnt').textContent = `${nIN.format(rows.length)} stocks match${rows.length > 400 ? '; showing the first 400' : ''}.`;
    };
    document.getElementById('s-tab').addEventListener('click', (e) => { const b = e.target.closest('th button'); if (!b) return; const kk = b.dataset.k; if (kk === sk) sd = -sd; else { sk = kk; sd = ['s', 'sec', 'cap'].includes(kk) ? 1 : -1; } tbl(); });
    document.getElementById('s-q').addEventListener('input', tbl);
    document.getElementById('s-f').addEventListener('change', tbl);
    tbl();
  }

  // ------------------------------------------------------------ SMART MONEY
  async function smart() {
    const sm = await load('smart.json');
    app.innerHTML = `
      <div class="ph"><h1>Is margin buying smart money?</h1><p>Each day, stocks are split into five groups by how much their margin book changed over 20 days. We then track what each group did next, against the average stock.</p></div>
      ${card({ id: 'm-q', title: 'What happens after margin builds or cuts', note: 'Average return after the signal minus the universe average.', ctl: seg('h', [['1W', '1 week'], ['1M', '1 month'], ['3M', '3 months']], '1M'), chart: '', ins: sm.insights })}
      <div class="grid">
        ${card({ id: 'm-y', title: 'Does it hold every year?', note: 'Biggest builders minus biggest cutters, average by calendar year.', chart: 'sm' })}
        ${card({ id: 'm-hv', title: 'Heavily margined stocks', note: 'Top 10% by margin as a share of market value, against the less-leveraged half.', chart: 'sm' })}
      </div>`;
    const k = C();
    const qs = document.getElementById('m-q'), qel = h('<div class="chart"></div>'); qs.insertBefore(qel, qs.querySelector('.ins-slot'));
    const labels = ['Biggest cut', 'Cut', 'Flat', 'Added', 'Biggest build'];
    const draw = (hz) => {
      const H = sm.horizons[hz];
      [qel, document.querySelector('#m-y .chart'), document.querySelector('#m-hv .chart')].forEach((el) => { const c = charts.find((x) => x.getDom() === el); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); } });
      bars(qel, labels, H.quintiles.map((q) => q.avg_excess), { fmt: (v) => pct(v, 2), label: true });
      bars(document.querySelector('#m-y .chart'), H.by_year.map((y) => String(y.year)), H.by_year.map((y) => y.spread), { fmt: (v) => pct(v, 2), label: true });
      if (H.heavy.length) bars(document.querySelector('#m-hv .chart'), ['Most leveraged 10%', 'Less leveraged half'], H.heavy, { fmt: (v) => pct(v, 2), label: true });
      const top = H.quintiles[4].avg_excess, bot = H.quintiles[0].avg_excess, lbl = { '1W': 'week', '1M': 'month', '3M': 'three months' }[hz];
      const good = H.by_year.filter((y) => y.spread > 0).length;
      setIns(qs, [`Over the next ${lbl}, the biggest margin builders returned ${pct(top, 2)} against the average stock, and the biggest cutters ${pct(bot, 2)}.`,
        Math.abs(top - bot) < 0.002 ? 'The gap is too small to matter: where margin money moves says little about what a stock does next.' : top > bot ? 'Margin buyers have leaned the right way on average, but the gap shifts from year to year.' : 'Over this horizon margin buyers have leaned the wrong way on average.',
        `The builders beat the cutters in ${good} of ${H.by_year.length} calendar years and on ${pct(H.hit, 0, false)} of signal days.`,
        H.heavy.length ? `The most leveraged stocks (margin as a share of market value) returned ${pct(H.heavy[0], 2)} versus the average, against ${pct(H.heavy[1], 2)} for the less-leveraged half. ${H.heavy[0] < H.heavy[1] ? 'Heavy leverage has been a headwind.' : 'Heavy leverage has not hurt returns so far.'}` : '',
        'Equal-weighted, before costs, over stocks with ₹10 cr or more funded and ₹10 cr of daily trading. Past patterns are not a forecast.']);
    };
    draw('1M'); onSeg(qs, 'h', draw);
    void k;
  }

  // ------------------------------------------------------------ STOCK EXPLORER
  async function stock(sym) {
    const [search, st] = await Promise.all([load('search.json'), load('stocks.json')]);
    const watch = store.get('mtf_watch', []);
    if (!sym) sym = watch[0] || st[0].s;
    app.innerHTML = `
      <div class="ph"><h1>Stock explorer</h1><p>Search any stock to see its margin history next to its price, with a read on what the numbers say.</p></div>
      <div class="ctl"><div class="search"><input class="inp" id="x-q" type="search" placeholder="Search a stock, for example HDFCBANK" aria-label="Search a stock" autocomplete="off"><div class="sugg" id="x-s" hidden></div></div></div>
      <section class="card" id="x-watch"><div class="card-h"><div><h2>My watchlist</h2><p class="note">Saved in this browser only. Changes compare today with your last visit.</p></div></div><div id="x-wl"></div></section>
      <div id="x-body"><div class="loading">Loading ${esc(sym)}…</div></div>`;
    // search box
    const q = document.getElementById('x-q'), box = document.getElementById('x-s');
    let hits = [], sel = 0;
    const show = () => {
      const v = q.value.trim().toUpperCase();
      if (!v) { box.hidden = true; return; }
      hits = search.filter(([s, n]) => s.startsWith(v)).concat(search.filter(([s, n]) => !s.startsWith(v) && (s.includes(v) || n.toUpperCase().includes(v)))).slice(0, 8);
      sel = 0;
      box.innerHTML = hits.map(([s, n], i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-s="${esc(s)}"><b>${esc(s)}</b><span>${esc(n)}</span></button>`).join('') || '<button type="button" disabled>No match</button>';
      box.hidden = false;
    };
    q.addEventListener('input', show);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length); box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === sel)); }
      if (e.key === 'Enter' && hits[sel]) location.hash = `stock/${encodeURIComponent(hits[sel][0])}`;
      if (e.key === 'Escape') box.hidden = true;
    });
    box.addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) location.hash = `stock/${encodeURIComponent(b.dataset.s)}`; });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; }, { once: true });
    renderWatch(st);

    let d;
    try { d = await load(`s/${sym.replace('/', '_')}.json`); } catch { document.getElementById('x-body').innerHTML = `<div class="err">No margin history found for ${esc(sym)}.</div>`; return; }
    const row = st.find((r) => r.s === sym);
    const inW = watch.includes(sym);
    const rank = row ? st.indexOf(row) + 1 : null;
    const ins = stockInsights(d, row, st);
    document.getElementById('x-body').innerHTML = `
      <section class="card">
        <div class="card-h"><div><h2 style="font-size:24px">${esc(d.s)} <span class="pill">${esc(d.t)}</span> <span class="pill">${esc(d.sec)}</span></h2><p class="note">${esc(d.n)}</p></div>
          <button class="btn ${inW ? 'ghost' : ''}" id="x-w" type="button">${inW ? 'Remove from watchlist' : 'Add to watchlist'}</button></div>
        <div class="kgroups" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))">
          ${tileK('Margin book', cr(row?.a ?? d.a[lastIdx(d.a)]), rank ? `#${rank} of ${nIN.format(st.length)} stocks` : '')}
          ${tileK('1 month', row ? `<span class="${tone(row.c21)}">${signCr(row.c21)}</span>` : 'n/a', row ? pct(row.p21) : '')}
          ${tileK('1 year', row ? `<span class="${tone(row.c250)}">${signCr(row.c250)}</span>` : 'n/a', row ? pct(row.p250, 0) : '')}
          ${tileK('Book / market cap', row ? pct(row.lev, 2, false) : 'n/a', row?.mc ? `Market cap ${crS(row.mc)}` : '')}
          ${tileK('Days to unwind', row?.dtu ?? 'n/a', row ? `Delivery ${pct(row.dp, 0, false)} of volume` : '')}
          ${tileK('Price', row?.px ? `₹${nIN2.format(row.px)}` : 'n/a', row ? `${pct(row.r21)} in 1 month` : '')}
        </div>
        <div class="insight"><span class="lbl">What the numbers say</span><ul>${ins.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
      </section>
      ${card({ id: 'x-c', title: 'Margin book and price', note: 'Weekly before the last year, daily after.', ctl: rangeSeg('1Y'), chart: 'lg' })}
      <div class="grid">${card({ id: 'x-l', title: 'Book as a share of market value', note: 'Margin funded divided by company market value.', chart: 'sm' })}
      ${card({ id: 'x-u', title: 'Days to unwind', note: 'Book divided by the average daily delivery value.', chart: 'sm' })}</div>`;
    function tileK(k, v, s) { return `<div class="kv" style="border:0;padding:0"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`; }
    document.getElementById('x-w').addEventListener('click', () => {
      const w = store.get('mtf_watch', []);
      const nx = w.includes(sym) ? w.filter((x) => x !== sym) : [sym, ...w].slice(0, 30);
      store.set('mtf_watch', nx); stock(sym);
    });
    const k = C();
    const sec = document.getElementById('x-c'), el = sec.querySelector('.chart');
    const draw = (range) => {
      const c = charts.find((x) => x.getDom() === el); if (c) { c.dispose(); charts = charts.filter((x) => x !== c); }
      const i0 = sliceRange(d.d, range);
      mk(el, base({
        tooltip: { ...base().tooltip, formatter: (ps) => `<b>${day(ps[0].axisValue)}</b><br>` + ps.map((p) => `${p.marker}${p.seriesName}: ${p.seriesIndex ? '₹' + nIN2.format(p.value) : cr(p.value)}`).join('<br>') },
        xAxis: xCat(d.d.slice(i0), { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }),
        yAxis: [yVal(crS), yVal((v) => '₹' + nIN.format(v), { splitLine: { show: false } })], dataZoom: [{ type: 'inside' }],
        series: [{ name: 'Margin book', type: 'line', data: d.a.slice(i0), showSymbol: false, lineStyle: { width: 2, color: k.c1 }, itemStyle: { color: k.c1 }, areaStyle: area(k.c1) },
                 { name: 'Price', type: 'line', yAxisIndex: 1, data: d.c.slice(i0), showSymbol: false, lineStyle: { width: 1.5, color: k.c2 }, itemStyle: { color: k.c2 } }],
      }));
    };
    draw('1Y'); onSeg(sec, 'range', draw);
    const small = (id, data, fmt, color) => mk(document.querySelector(`#${id} .chart`), base({ tooltip: { ...base().tooltip, valueFormatter: fmt },
      xAxis: xCat(d.d, { axisLabel: { color: k.subtle, fontSize: 11, hideOverlap: true, formatter: dateLabel } }), yAxis: yVal(fmt), dataZoom: [{ type: 'inside' }],
      series: [{ type: 'line', data, showSymbol: false, lineStyle: { width: 2, color }, itemStyle: { color }, areaStyle: area(color) }] }));
    if (d.l) small('x-l', d.l, (v) => pct(v, 2, false), k.c3);
    small('x-u', d.u, (v) => `${(+v).toFixed(1)} days`, k.c4);
    // remember what we saw for the watchlist comparison
    const seen = store.get('mtf_seen', {}); if (row) { seen[sym] = row.a; store.set('mtf_seen', seen); }
  }

  function renderWatch(st) {
    const w = store.get('mtf_watch', []), seen = store.get('mtf_seen', {}), el = document.getElementById('x-wl');
    if (!w.length) { el.innerHTML = '<p class="note">Open any stock and choose Add to watchlist. Your list stays on this device.</p>'; return; }
    const rows = w.map((s) => st.find((r) => r.s === s) || { s });
    el.innerHTML = `<div class="tbox"><table><thead><tr><th>Stock</th><th class="n">Book</th><th class="n">Today</th><th class="n">1 week</th><th class="n">1 month</th><th class="n">Since last visit</th></tr></thead><tbody>${rows.map((r) => {
      const since = r.a != null && seen[r.s] != null ? r.a - seen[r.s] : null;
      return `<tr><td>${symLink(r.s)}</td><td class="n">${cr(r.a)}</td><td class="n ${tone(r.c1)}">${signCr(r.c1)}</td><td class="n ${tone(r.c5)}">${signCr(r.c5)}</td><td class="n ${tone(r.c21)}">${signCr(r.c21)}</td><td class="n ${tone(since)}">${since == null ? 'n/a' : signCr(since)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function stockInsights(d, r, st) {
    const out = [];
    const a = d.a.filter((v) => v != null);
    if (!r) { out.push('This stock has no margin funding today; the chart shows its past book.'); return out; }
    const last = a.slice(-250), mx = Math.max(...last), mn = Math.min(...last);
    if (r.a >= mx * 0.995) out.push(`The margin book of ${cr(r.a)} is at its highest level in a year.`);
    else if (r.a <= mn * 1.005) out.push(`The margin book of ${cr(r.a)} is at its lowest level in a year.`);
    else out.push(`The margin book of ${cr(r.a)} sits at the ${ord((r.pr ?? 0) * 100)} percentile of its last year (range ${cr(mn)} to ${cr(mx)}).`);
    if (r.p21 != null && r.r21 != null) {
      const bk = r.p21, px = r.r21;
      const B = bk > 0.03 ? 1 : bk < -0.03 ? -1 : 0, X = px > 0.03 ? 1 : px < -0.03 ? -1 : 0;
      const txt = {
        '1,1': `Margin rose ${pct(bk)} over the month with the price up ${pct(px)}: leveraged traders are riding the move, which adds fuel now and forced sellers later.`,
        '1,-1': `Margin rose ${pct(bk)} while the price fell ${pct(px)}: leveraged holders are buying the dip, so more margin calls wait below if the fall continues.`,
        '1,0': `Margin rose ${pct(bk)} while the price barely moved (${pct(px)}): leverage is building ahead of a move.`,
        '-1,1': `The price rose ${pct(px)} while margin was cut ${pct(bk)}: the rally is being paid for in cash, and margin traders are taking profits.`,
        '-1,-1': `Margin was cut ${pct(bk)} as the price fell ${pct(px)}: leveraged positions are being unwound, which often marks forced selling.`,
        '-1,0': `Margin was cut ${pct(bk)} while the price held steady (${pct(px)}): leverage is leaving quietly, without a sell-off.`,
        '0,1': `The price rose ${pct(px)} while margin held roughly steady (${pct(bk)}): the move is not being driven by leverage.`,
        '0,-1': `The price fell ${pct(px)} while margin held roughly steady (${pct(bk)}): leveraged holders are sitting tight, so margin calls could follow if the fall continues.`,
        '0,0': `Margin (${pct(bk)}) and price (${pct(px)}) both moved little over the month.`,
      }[`${B},${X}`];
      out.push(txt);
    }
    const levs = st.filter((x) => x.lev != null && x.mc >= 500).map((x) => x.lev).sort((x, y) => x - y);
    if (r.lev != null && levs.length) {
      const p = levs.filter((x) => x <= r.lev).length / levs.length;
      out.push(`${pct(r.lev, 2, false)} of the company's market value is on margin, more than ${Math.round(p * 100)}% of comparable stocks.`);
    }
    if (r.dtu != null) out.push(r.dtu >= 20 ? `It would take about ${r.dtu} days of normal delivery buying to absorb this margin book, which makes a forced exit slow and painful.` :
      r.dtu <= 3 ? `At ${r.dtu} days to unwind, the margin book is small next to normal delivery volume and easy to absorb.` :
      `At ${r.dtu} days to unwind, the margin book is moderate next to normal delivery volume.`);
    if (r.z != null && Math.abs(r.z) >= 2.5) out.push(`Today's margin change was ${Math.abs(r.z).toFixed(1)} times its usual daily swing, an unusual ${r.z > 0 ? 'build' : 'cut'}.`);
    return out;
  }

  // ------------------------------------------------------------ ABOUT
  async function about() {
    const b = await load('build.json');
    app.innerHTML = `<article class="card about">
      <h1 style="font-size:28px">About the RECO MTF Lens Analyzer</h1>
      <p>The RECO MTF Lens Analyzer tracks India's Margin Trading Facility book: the money brokers lend investors to buy shares, which those investors pay interest on and must top up when prices fall. A large, fast-growing book means more forced selling waits below the market if prices drop.</p>
      <h2>Data</h2>
      <ul>
        <li>NSE's daily margin trading disclosure: amount funded and shares funded for every stock, and the day's new and closed positions.</li>
        <li>NSE's full bhavcopy: prices, volume, turnover and delivery for every stock.</li>
        <li>NSE index closes for the Nifty 50, Nifty 500, Midcap 150, Smallcap 250 and India VIX.</li>
        <li>NSE's market-cap file, captured on the first trading day of each month and on the latest day.</li>
      </ul>
      <p>History runs from ${day(b.start)} to ${day(b.asof)} (${nIN.format(b.days)} trading days). BSE's smaller margin book is not included. The site rebuilds itself every evening after NSE publishes, last built ${esc(b.built.replace('T', ' ').replace('Z', ' UTC'))}.</p>
      <h2>Definitions</h2>
      <ul>
        <li><b>Net flow:</b> new margin positions minus positions closed, in rupees.</li>
        <li><b>Days to unwind:</b> a stock's margin book divided by its average daily delivery value over 20 days. It approximates how many days of normal buying it would take to absorb forced selling.</li>
        <li><b>Book / market cap:</b> margin funded as a share of company market value. The share of the free float is higher, since promoters rarely trade.</li>
        <li><b>Cap class:</b> SEBI's method, ranking by market value: 1 to 100 large, 101 to 250 mid, 251 to 500 small, beyond that micro.</li>
        <li><b>Leverage Stress Index:</b> the average percentile, against every day since December 2021, of four readings: book versus market value, three-month book growth, margin share of cash turnover and book-weighted days to unwind.</li>
        <li><b>Margin flush:</b> the book falling 3% or more within five trading days.</li>
      </ul>
      <h2>Caveats</h2>
      <ul>
        <li>F&amp;O and ETF membership uses today's lists for the whole history.</li>
        <li>Prices are adjusted for splits and bonuses by detecting split-sized overnight gaps; windows with a demerger-sized jump are left out of the return studies.</li>
        <li>Nothing here is a recommendation to buy or sell any security.</li>
      </ul></article>`;
  }

  // ------------------------------------------------------------ router
  const routes = { overview, flows, composition, risk, stocks, smart, stock, about };
  async function route() {
    const [r, arg] = (location.hash.slice(1) || 'overview').split('/');
    const fn = routes[r] || overview;
    charts.forEach((c) => c.dispose()); charts = [];
    document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.r === (routes[r] ? r : 'overview')) || a.setAttribute('aria-current', a.dataset.r === r ? 'page' : ''));
    document.querySelectorAll('.nav a').forEach((a) => { if (a.dataset.r === (routes[r] ? r : 'overview')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    app.innerHTML = '<div class="loading">Loading…</div>';
    try { await fn(arg ? decodeURIComponent(arg) : undefined); }
    catch (e) { console.error(e); app.innerHTML = `<div class="err">Could not load this dashboard (${esc(e.message)}). Try refreshing the page.</div>`; }
    window.scrollTo(0, 0);
  }

  // theme toggle: system by default, then remembered
  const savedTheme = store.get('mtf_theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  document.getElementById('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('mtf_theme', document.documentElement.dataset.theme);
    route();
  });

  fetch('data/build.json', { cache: 'no-store' }).then((r) => r.json()).then((b) => {
    VER = b.built;
    document.getElementById('foot-asof').textContent = `Data as of ${day(b.asof)}, rebuilt ${b.built.replace('T', ' ').replace('Z', ' UTC')}.`;
  }).catch(() => {}).finally(() => { window.addEventListener('hashchange', route); route(); });
})();
