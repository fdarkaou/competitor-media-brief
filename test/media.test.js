import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL, parseApp, daysBetween, toReport, diff, diffIsEmpty, diffLines, toMarkdown, toCsv, toChat } from '../media.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
const current = load('media.json');
const previous = load('previous.json');

test('parses ids, links and labels', () => {
  assert.deepEqual(parseApp('1000000001'), { storeId: '1000000001', label: null });
  assert.deepEqual(parseApp('https://apps.apple.com/us/app/example/id1000000001=Rival'), { storeId: '1000000001', label: 'Rival' });
  assert.equal(parseApp('https://apps.apple.com/us/app/example/id1000000001').storeId, '1000000001');
  assert.equal(parseApp('nope'), null);
});

test('whole UTC days, null when unknown', () => {
  assert.equal(daysBetween('2026-11-08T00:00:00.000Z', '2026-11-12T08:00:00.000Z'), 4);
  assert.equal(daysBetween(null, '2026-11-12'), null);
  assert.equal(daysBetween('2026-11-13', '2026-11-12'), null);
});

test('reads saved entries, a bare media response, or a saved report', () => {
  const r = toReport(current);
  assert.equal(r.tool, TOOL);
  assert.equal(r.totals.apps, 2);
  assert.equal(r.totals.liveAdsRead, 3);
  assert.equal(r.totals.appsWithWebFunnel, 1);
  assert.equal(r.totals.appsWithoutStoredAds, 1);
  assert.equal(toReport(r), r);
  const bare = toReport(current[0].media);
  assert.equal(bare.apps[0].liveAdsRead, 2);
  assert.equal(bare.apps[0].liveAdsComplete, false);
  assert.throws(() => toReport({ data: [] }), /Expected a PeekPanda media response/);
  assert.throws(() => toReport([]), /Expected a PeekPanda media response/);
});

test('destination shares, landing pages, ads and organic matches', () => {
  const a = toReport(current).apps[0];
  assert.deepEqual(a.destinations, { appStore: 14, playStore: 2, web: 6, unknown: 1 });
  assert.equal(a.webShare, 26);
  assert.deepEqual(a.landingPages.map((p) => p.page), ['apps.apple.com/app/id1000000001', 'try.example-calories.com/quiz']);
  assert.equal(a.liveAdsComplete, true);
  assert.deepEqual(a.ads.map((x) => x.daysLive), [4, 53, 190]);
  assert.equal(a.longestDaysLive, 190);
  assert.deepEqual(a.adHosts.map((x) => x.key), ['apps.apple.com', 'try.example-calories.com']);
  assert.deepEqual(a.organic.map((o) => o.score), [0.97, 0.91]);
  const b = toReport(current).apps[1];
  assert.equal(b.webShare, null);
});

test('diff: destination moves, new hosts, pages, ads, organic; gone only on complete reads', () => {
  const d = diff(toReport(current), previous);
  assert.equal(d.apps.length, 1);
  const c = d.apps[0];
  assert.deepEqual(c.destMoves, [{ key: 'appStore', from: 13, to: 14 }, { key: 'web', from: 0, to: 6 }]);
  assert.deepEqual(c.newHosts, ['try.example-calories.com']);
  assert.deepEqual(c.newPages, ['try.example-calories.com/quiz']);
  assert.deepEqual(c.newAds.map((x) => x.key), ['paid:meta:111000004']);
  assert.deepEqual(c.goneAds.map((x) => x.key), ['paid:meta:111000002']);
  assert.deepEqual(c.newOrganic.map((x) => x.sourceId), ['organic-ex-3']);
  assert.ok(diffLines(d).some((l) => l.includes('Web ads 0 → 6')));
  assert.ok(diffIsEmpty(diff(toReport(current), current)));
  const partial = JSON.parse(JSON.stringify(current));
  partial[0].pages = [];
  assert.equal(diff(toReport(partial), previous).apps[0].goneAds.length, 0);
});

test('markdown, csv and chat output', () => {
  const r = toReport(current);
  const md = toMarkdown(r, diff(r, previous));
  assert.match(md, /\| Example Calories \| 14 \| 2 \| 6 \| 1 \| 26% \| 3 \| 190 \| 2 \|/);
  assert.match(md, /Since the last report/);
  assert.match(md, /not proof of none anywhere/);
  const csv = toCsv(r).split('\n');
  assert.equal(csv.length, 1 + 3 + 1);
  assert.match(csv[1], /"Scan your plate, get calories in seconds"/);
  assert.match(toChat(r), /Example Calories: App Store 14, Play Store 2, Web 6, Unknown 1/);
  assert.doesNotMatch(JSON.stringify(r), /cdn\.example\.com/);
});
