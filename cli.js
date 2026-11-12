#!/usr/bin/env node
// Competitor media brief from PeekPanda. Node 18+, no dependencies.
//   GET /v1/competitors/ios/{storeId}/media   paid-ad destinations, live ads page, organic matches (MCP get_app media)
//   GET /v1/paid-ads?storeIds=...&status=active&sort=recently_discovered&cursor=...   more live ads (MCP get_ads search)
// These reads return stored observations and never start collection.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseApp, toReport, toMarkdown, toCsv, toChat, diff } from './media.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --app <storeId|App Store link>[=Label] [--app ...] [opts]
  node cli.js --file media.json [opts]          read saved responses or a saved report

Options:
  --pages <n>              live-ad pages per app, 1–10 (default 1 = the page the media read returns;
                           more pages follow nextCursor on GET /v1/paid-ads, one call each)
  --state <path>           compare with the report saved at this path, then save this run there
  --archive <dir>          also save the raw responses as <dir>/competitor-media-<YYYY-MM-DD>.json
  --format md|csv|json     output format (default md; json is this tool's report)
  --webhook <url>          also POST a short summary to a Slack or Discord incoming webhook
  --tenancy <value>        x-genviral-tenancy header (default personal)
  --api <url>              API base (default https://api.peekpanda.com)

Every call counts toward your plan's daily API and MCP allowance (Peek 30, Panda 1,000, reset 00:00 UTC).`;

function parse(argv) {
  const o = { format: 'md', tenancy: 'personal', api: 'https://api.peekpanda.com', apps: [], pages: '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--app') {
      const v = argv[++i];
      if (v == null) throw new Error('--app needs a value.');
      o.apps.push(...String(v).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value. See --help.`);
      o[a.slice(2)] = v;
    } else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(o, path, retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new Error('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  const res = await fetch(new URL(path, o.api), { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'x-genviral-tenancy': o.tenancy } });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? '';
  const retry = Number(res.headers.get('retry-after') ?? body?.error?.retryAfterSeconds);
  // 429 rate_limited and 503 timeout: honor a short Retry-After once. daily_call_limit: stop.
  if ((code === 'rate_limited' || code === 'timeout') && !retried && retry > 0 && retry <= 70) {
    await sleep(retry * 1000);
    return call(o, path, true);
  }
  const hints = {
    daily_call_limit: ' The daily API and MCP allowance is used until 00:00 UTC; stopping.',
    subscription_required: ' This read needs a plan with API access.',
    workspace_not_accessible: ' The key cannot reach that tenancy; check --tenancy.',
    not_found: ' The app is outside the accessible catalogue.',
  };
  const err = new Error(`PeekPanda API ${res.status} ${code} (${path.split('?')[0]}): ${String(body?.error?.message ?? res.statusText).replace(/\.$/, '')}.${hints[code] ?? ''}`);
  err.code = code;
  throw err;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (!['md', 'csv', 'json'].includes(o.format)) throw new Error('--format must be md, csv or json');
  const pages = Number(o.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > 10) throw new Error('--pages must be 1 to 10');

  let raw = null, input;
  const fetchedAt = o.file ? null : new Date().toISOString();
  if (o.file) input = JSON.parse(await readFile(o.file, 'utf8'));
  else {
    const apps = o.apps.map((s) => {
      const p = parseApp(s);
      if (!p) throw new Error(`"${s}" is not an App Store id or apps.apple.com link`);
      return p;
    });
    if (!apps.length) throw new Error('Pass --app (one or more) or --file. See --help.');
    const calls = apps.length * pages;
    if (calls > 30) console.error(`Note: up to ${calls} calls; Peek allows 30 API and MCP calls a UTC day.`);
    raw = [];
    for (const a of apps) {
      const media = await call(o, `/v1/competitors/ios/${a.storeId}/media`);
      const more = [];
      let cursor = media.paidAds?.hasMore ? media.paidAds.nextCursor : null;
      while (cursor && more.length < pages - 1) {
        const q = new URLSearchParams({ storeIds: a.storeId, status: 'active', sort: 'recently_discovered', cursor });
        const page = await call(o, `/v1/paid-ads?${q}`);
        more.push({ items: page.items ?? [], nextCursor: page.nextCursor ?? null, hasMore: Boolean(page.hasMore) });
        cursor = page.hasMore ? page.nextCursor : null;
      }
      raw.push({ storeId: a.storeId, label: a.label, fetchedAt, media, pages: more });
    }
    input = raw;
  }
  const report = toReport(input, { fetchedAt });

  let d = null;
  if (o.state) {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse).catch(() => null);
    try { d = diff(report, prev); } catch { console.error(`Note: ${o.state} is not a competitor-media-brief report or media response, so no comparison was made. It will be replaced.`); }
    await writeFile(o.state, JSON.stringify(report, null, 2));
  }
  if (o.archive) {
    await mkdir(o.archive, { recursive: true });
    const stamp = (report.fetchedAt ?? new Date().toISOString()).slice(0, 10);
    await writeFile(join(o.archive, `competitor-media-${stamp}.json`), JSON.stringify(raw ?? input, null, 2));
  }

  if (o.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (o.format === 'csv') console.log(toCsv(report));
  else console.log(toMarkdown(report, d));

  if (o.webhook) {
    const text = toChat(report, d);
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const r = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: text.slice(0, 1900) } : { text }) });
    if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
