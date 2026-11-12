// Competitor media brief: read PeekPanda's stored media view of one or more iOS apps
// (paid-ad destinations, the live ads page and organic-post matches) and turn it into a
// short report: where each rival sends its ad clicks, what it runs now, which public posts
// mention it, and what changed since the last read. No dependencies. Node 18+ and browsers.
//   GET /v1/competitors/ios/{storeId}/media    (MCP get_app, action media, scope context:read)
//   GET /v1/paid-ads?storeIds={storeId}&status=active&sort=recently_discovered&cursor=...
//                                              (MCP get_ads, action search: continues the live ads page)
// These reads return stored observations and never start collection.

export const TOOL = 'competitor-media-brief';
export const DEST_KEYS = ['appStore', 'playStore', 'web', 'unknown'];
export const DEST_LABEL = { appStore: 'App Store', playStore: 'Play Store', web: 'Web', unknown: 'Unknown' };
export const SOURCE_COPY = 'Destinations count where the app’s stored ads sent their clicks; only App Store ads count as App Store. The live ads list is newest discovered first and is about a minute behind new ads. Organic matches are suggestions tied by App Store link, website or name, not verified ownership. There is no spend, reach or performance in this read.';

export const fmt = (n) => (n == null ? '—' : typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const day = (s) => (s ? String(s).slice(0, 10) : '—');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x) => (x == null || x === '' ? null : String(x));
const pct = (a, b) => (b > 0 && a != null ? Math.round((a / b) * 100) : null);

export function parseApp(input) {
  const raw = String(input ?? '').trim();
  const eq = raw.lastIndexOf('=');
  const hasLabel = eq > 0 && !/^https?:/i.test(raw.slice(eq + 1)) && !raw.slice(eq + 1).includes('/');
  const idPart = hasLabel ? raw.slice(0, eq) : raw;
  const label = hasLabel ? raw.slice(eq + 1).trim() || null : null;
  let id = null;
  if (/^\d{3,20}$/.test(idPart)) id = idPart;
  else {
    const m = idPart.match(/\/id(\d{3,20})/i) || idPart.match(/^id(\d{3,20})$/i);
    if (m) id = m[1];
  }
  return id ? { storeId: id, label } : null;
}

// Whole UTC days from the ad's start day to the read day (same rule PeekPanda uses for run lengths).
export function daysBetween(startedAt, at) {
  if (!startedAt || !at) return null;
  const a = Date.parse(String(startedAt).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(at).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

function adOf(ad, readAt) {
  const c = ad.creative ?? {};
  const d = ad.destination ?? {};
  return {
    key: str(ad.canonicalKey) ?? (ad.platform && ad.archiveId ? `paid:${ad.platform}:${ad.archiveId}` : str(ad.id)),
    platform: str(ad.platform),
    advertiser: str(ad.advertiser?.name),
    status: str(ad.status),
    format: str(c.format),
    hook: str(c.hook) ?? str(c.title),
    cta: str(c.ctaText),
    destinationKind: str(d.kind),
    destinationHost: str(d.host) ?? (d.url ? safeHost(d.url) : null),
    destinationAppStoreId: str(d.appStoreId),
    startedAt: str(ad.startedAt),
    discoveredAt: str(ad.discoveredAt),
    daysLive: ad.endedAt ? null : daysBetween(ad.startedAt, readAt),
    sourceUrl: str(ad.sourceUrl),
  };
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return null; }
}

function landingOf(p) {
  if (typeof p === 'string') return { page: p, url: null, kind: null, adCount: null, activeCount: null };
  return {
    page: str(p?.page) ?? str(p?.host) ?? (p?.url ? safeHost(p.url) : null),
    url: str(p?.url),
    kind: str(p?.kind),
    adCount: num(p?.adCount),
    activeCount: num(p?.activeCount),
  };
}

function organicOf(o) {
  return {
    sourceId: str(o.sourceId),
    productName: str(o.productName),
    caption: str(o.caption),
    link: str(o.link),
    matchStatus: str(o.match?.status),
    evidence: str(o.match?.evidence),
    score: num(o.match?.score),
  };
}

const isMedia = (x) => x && typeof x === 'object' && !Array.isArray(x) && ('paidAdDestinations' in x || 'paidAds' in x || 'organic' in x);
const isReport = (x) => x && x.tool === TOOL && Array.isArray(x.apps);

// One entry: { storeId, label?, media, pages? } as the CLI saves it, or a bare media response.
function appOf(entry, i, readAt) {
  const media = isMedia(entry) ? entry : entry?.media;
  if (!isMedia(media)) throw new Error('Expected a PeekPanda media response (GET /v1/competitors/ios/{storeId}/media) with paidAdDestinations, paidAds or organic.');
  const pages = [media.paidAds ?? { items: [], nextCursor: null, hasMore: false }, ...(Array.isArray(entry?.pages) ? entry.pages : [])];
  const seen = new Set();
  const ads = [];
  for (const p of pages) for (const ad of Array.isArray(p?.items) ? p.items : []) {
    const a = adOf(ad, readAt);
    if (a.key && seen.has(a.key)) continue;
    if (a.key) seen.add(a.key);
    ads.push(a);
  }
  const last = pages[pages.length - 1] ?? {};
  const complete = !last.hasMore;
  const dRaw = media.paidAdDestinations ?? null;
  const destinations = dRaw ? Object.fromEntries(DEST_KEYS.map((k) => [k, num(dRaw[k])])) : null;
  const destTotal = destinations ? DEST_KEYS.reduce((s, k) => s + (destinations[k] ?? 0), 0) : null;
  const landingPages = (Array.isArray(dRaw?.landingPages) ? dRaw.landingPages : []).map(landingOf).filter((p) => p.page || p.url);
  const organic = (Array.isArray(media.organic?.data) ? media.organic.data : []).map(organicOf)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const count = (arr, f) => {
    const m = new Map();
    for (const x of arr) { const k = f(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, count: n }));
  };
  const runs = ads.map((a) => a.daysLive).filter((x) => x != null);
  return {
    storeId: str(entry?.storeId) ?? str(media.storeId) ?? `app-${i + 1}`,
    label: str(entry?.label) ?? ads.find((a) => a.advertiser)?.advertiser ?? organic.find((o) => o.productName)?.productName ?? null,
    destinations,
    destinationsTotal: destTotal,
    webShare: destinations ? pct(destinations.web, destTotal) : null,
    landingPages,
    liveAdsRead: ads.length,
    liveAdsComplete: complete,
    ads,
    adHosts: count(ads, (a) => a.destinationHost),
    adPlatforms: count(ads, (a) => a.platform),
    adFormats: count(ads, (a) => a.format),
    adCtas: count(ads, (a) => a.cta),
    longestDaysLive: runs.length ? Math.max(...runs) : null,
    newestDiscoveredAt: ads.map((a) => a.discoveredAt).filter(Boolean).sort().pop() ?? null,
    organic,
    organicByStatus: count(organic, (o) => o.matchStatus),
    organicCandidateLimitReached: media.organic?.candidateLimitReached ?? null,
  };
}

export function toReport(input, { fetchedAt = null } = {}) {
  if (isReport(input)) return input;
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) throw new Error('Expected a PeekPanda media response (GET /v1/competitors/ios/{storeId}/media) with paidAdDestinations, paidAds or organic.');
  const readAt = fetchedAt ?? list.find((e) => e?.fetchedAt)?.fetchedAt ?? null;
  const apps = list.map((e, i) => appOf(e, i, readAt ?? e?.fetchedAt ?? null));
  const sum = (f) => apps.reduce((s, a) => s + (f(a) ?? 0), 0);
  return {
    tool: TOOL,
    fetchedAt: readAt,
    apps,
    totals: {
      apps: apps.length,
      liveAdsRead: sum((a) => a.liveAdsRead),
      organicMatches: sum((a) => a.organic.length),
      appsWithWebFunnel: apps.filter((a) => (a.destinations?.web ?? 0) > 0).length,
      appsWithoutStoredAds: apps.filter((a) => a.destinationsTotal === 0 && a.liveAdsRead === 0).length,
    },
  };
}

export function diff(curr, prev) {
  if (!prev) return null;
  const p = toReport(prev);
  const byId = new Map(p.apps.map((a) => [a.storeId, a]));
  const out = { apps: [], firstSeen: [] };
  for (const a of curr.apps) {
    const b = byId.get(a.storeId);
    if (!b) { out.firstSeen.push(a.storeId); continue; }
    const name = a.label ?? a.storeId;
    const prevAds = new Set(b.ads.map((x) => x.key));
    const currAds = new Set(a.ads.map((x) => x.key));
    const newAds = a.ads.filter((x) => x.key && !prevAds.has(x.key));
    // "Gone" only when both reads walked the whole live list, otherwise an ad may sit on a later page.
    const goneAds = a.liveAdsComplete && b.liveAdsComplete ? b.ads.filter((x) => x.key && !currAds.has(x.key)) : [];
    const destMoves = [];
    if (a.destinations && b.destinations) for (const k of DEST_KEYS) {
      const x = b.destinations[k], y = a.destinations[k];
      if (x != null && y != null && x !== y) destMoves.push({ key: k, from: x, to: y });
    }
    const prevPages = new Set(b.landingPages.map((x) => x.page ?? x.url));
    const currPages = new Set(a.landingPages.map((x) => x.page ?? x.url));
    const newPages = a.landingPages.filter((x) => !prevPages.has(x.page ?? x.url)).map((x) => x.page ?? x.url);
    const gonePages = b.landingPages.filter((x) => !currPages.has(x.page ?? x.url)).map((x) => x.page ?? x.url);
    const prevHosts = new Set(b.adHosts.map((x) => x.key));
    const newHosts = a.adHosts.map((x) => x.key).filter((h) => !prevHosts.has(h));
    const prevOrg = new Set(b.organic.map((x) => x.sourceId));
    const newOrganic = a.organic.filter((x) => x.sourceId && !prevOrg.has(x.sourceId));
    const change = { storeId: a.storeId, name, newAds, goneAds, destMoves, newPages, gonePages, newHosts, newOrganic };
    if (newAds.length || goneAds.length || destMoves.length || newPages.length || gonePages.length || newHosts.length || newOrganic.length) out.apps.push(change);
  }
  return out;
}

export const diffIsEmpty = (d) => !d || (!d.apps.length && !d.firstSeen.length);

export function diffLines(d) {
  if (!d) return [];
  const lines = [];
  for (const c of d.apps) {
    for (const m of c.destMoves) lines.push(`${c.name}: ${DEST_LABEL[m.key]} ads ${m.from} → ${m.to}`);
    if (c.newHosts.length) lines.push(`${c.name}: new ad destination ${c.newHosts.length > 1 ? 'hosts' : 'host'} ${c.newHosts.join(', ')}`);
    if (c.newPages.length) lines.push(`${c.name}: new landing ${c.newPages.length > 1 ? 'pages' : 'page'} ${c.newPages.join(', ')}`);
    if (c.gonePages.length) lines.push(`${c.name}: landing ${c.gonePages.length > 1 ? 'pages' : 'page'} no longer listed ${c.gonePages.join(', ')}`);
    if (c.newAds.length) lines.push(`${c.name}: ${c.newAds.length} new live ${c.newAds.length > 1 ? 'ads' : 'ad'} (${c.newAds.slice(0, 3).map(adShort).join('; ')}${c.newAds.length > 3 ? '; …' : ''})`);
    if (c.goneAds.length) lines.push(`${c.name}: ${c.goneAds.length} ${c.goneAds.length > 1 ? 'ads' : 'ad'} no longer in the live list`);
    if (c.newOrganic.length) lines.push(`${c.name}: ${c.newOrganic.length} new organic ${c.newOrganic.length > 1 ? 'matches' : 'match'} (${c.newOrganic.slice(0, 2).map((o) => o.link ?? o.sourceId).join(', ')})`);
  }
  if (d.firstSeen.length) lines.push(`First read for ${d.firstSeen.join(', ')}`);
  return lines;
}

const adShort = (a) => [a.platform, a.format, a.destinationHost ?? a.destinationKind].filter(Boolean).join(' ') + (a.hook ? ` “${clip(a.hook, 50)}”` : '');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');
const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const destCell = (a, k) => (a.destinations ? fmt(a.destinations[k]) : '—');

export function toMarkdown(r, d = null) {
  const L = [];
  L.push('## Competitor media brief', '');
  const t = r.totals;
  L.push(`${t.apps} app(s), ${t.liveAdsRead} live ad(s) read, ${t.organicMatches} organic match(es). ${t.appsWithWebFunnel} app(s) send some ad clicks to the web.${r.fetchedAt ? ` Read ${day(r.fetchedAt)}.` : ''}`, '');
  L.push('### Where the ad clicks go', '');
  L.push('| App | App Store | Play Store | Web | Unknown | Web share | Live ads read | Longest live (days) | Organic matches |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of r.apps) L.push(`| ${cell(a.label ?? a.storeId)} | ${destCell(a, 'appStore')} | ${destCell(a, 'playStore')} | ${destCell(a, 'web')} | ${destCell(a, 'unknown')} | ${a.webShare == null ? '—' : a.webShare + '%'} | ${a.liveAdsRead}${a.liveAdsComplete ? '' : '+'} | ${fmt(a.longestDaysLive)} | ${a.organic.length} |`);
  L.push('');
  if (d) {
    L.push('### Since the last report', '');
    const lines = diffLines(d);
    L.push(...(lines.length ? lines.map((x) => `- ${x}`) : ['- No changes.']), '');
  }
  for (const a of r.apps) {
    L.push(`### ${a.label ?? a.storeId} (${a.storeId})`, '');
    if (a.landingPages.length) {
      L.push('Landing pages: ' + a.landingPages.map((p) => `${p.page ?? p.url}${p.kind ? ` (${p.kind}${p.adCount != null ? `, ${p.adCount} ads` : ''})` : ''}`).join(', '), '');
    }
    if (a.ads.length) {
      L.push(`Live ads (${a.liveAdsRead}${a.liveAdsComplete ? '' : ', more on later pages'}): ${a.adPlatforms.map((x) => `${x.key} ${x.count}`).join(', ')}; formats ${a.adFormats.map((x) => `${x.key} ${x.count}`).join(', ') || '—'}; CTAs ${a.adCtas.slice(0, 3).map((x) => `“${x.key}” ${x.count}`).join(', ') || '—'}.`, '');
      L.push('| Discovered | Platform | Format | Days live | Destination | CTA | Hook |', '|---|---|---|---|---|---|---|');
      for (const x of a.ads.slice(0, 10)) L.push(`| ${day(x.discoveredAt)} | ${cell(x.platform)} | ${cell(x.format)} | ${fmt(x.daysLive)} | ${cell(x.destinationHost ?? x.destinationKind)} | ${cell(x.cta)} | ${cell(clip(x.hook, 70))} |`);
      if (a.ads.length > 10) L.push(`| … | ${a.ads.length - 10} more in CSV/JSON | | | | | |`);
      L.push('');
    } else L.push(a.destinationsTotal ? 'No live ads in the stored list right now.' : 'No stored paid ads for this app (not collected, or none found; not proof of none anywhere).', '');
    if (a.organic.length) {
      L.push(`Organic matches (${a.organic.length}${a.organicCandidateLimitReached ? ', candidate limit reached' : ''}): ${a.organicByStatus.map((x) => `${x.key} ${x.count}`).join(', ')}.`, '');
      for (const o of a.organic.slice(0, 5)) L.push(`- ${o.link ?? o.sourceId} (${[o.matchStatus, o.evidence, o.score != null ? `score ${o.score}` : null].filter(Boolean).join(', ')})${o.caption ? `: ${clip(o.caption.replace(/\s+/g, ' '), 90)}` : ''}`);
      L.push('');
    }
  }
  L.push(`_${SOURCE_COPY}_`);
  return L.join('\n');
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row per app × live ad; apps without ads still get one row with their destination counts.
export function toCsv(r) {
  const head = ['store_id', 'app', 'dest_app_store', 'dest_play_store', 'dest_web', 'dest_unknown', 'web_share_pct', 'landing_pages', 'ad_key', 'platform', 'format', 'status', 'started_at', 'discovered_at', 'days_live', 'destination_kind', 'destination_host', 'cta', 'hook', 'source_url'];
  const rows = [head];
  for (const a of r.apps) {
    const base = [a.storeId, a.label, a.destinations?.appStore, a.destinations?.playStore, a.destinations?.web, a.destinations?.unknown, a.webShare, a.landingPages.map((p) => p.page ?? p.url).join(' ')];
    if (!a.ads.length) rows.push([...base, '', '', '', '', '', '', '', '', '', '', '', '']);
    for (const x of a.ads) rows.push([...base, x.key, x.platform, x.format, x.status, x.startedAt, x.discoveredAt, x.daysLive, x.destinationKind, x.destinationHost, x.cta, x.hook, x.sourceUrl]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

export function toChat(r, d = null) {
  const L = [`Competitor media brief: ${r.totals.apps} app(s), ${r.totals.liveAdsRead} live ad(s), ${r.totals.appsWithWebFunnel} with web funnels.`];
  for (const a of r.apps) L.push(`• ${a.label ?? a.storeId}: ${a.destinations ? DEST_KEYS.filter((k) => a.destinations[k]).map((k) => `${DEST_LABEL[k]} ${a.destinations[k]}`).join(', ') || 'no stored ads' : 'no destination data'}; ${a.liveAdsRead}${a.liveAdsComplete ? '' : '+'} live; ${a.organic.length} organic`);
  const lines = diffLines(d);
  if (d) L.push(lines.length ? 'Changes:\n' + lines.map((x) => `– ${x}`).join('\n') : 'No changes since the last report.');
  return L.join('\n');
}
