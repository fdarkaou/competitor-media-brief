# competitor-media-brief

Where do your rival iOS apps send their ad clicks? Some send every Meta and TikTok ad straight to the App Store. Others send part of them to a web quiz or checkout page first, which PeekPanda counts as a web funnel. This tool reads PeekPanda's stored media view of each app and gives you one short brief: how many of its stored ads go to the App Store, the Play Store or the web, which landing pages they use, which ads are live now, and which public organic posts mention the app. With `--state` it lists what changed since the last run, for example a rival that just started sending ads to a new web page.

Output is Markdown, CSV or JSON, and it can post a short summary to Slack or Discord. Node 18+, no dependencies. There is also a [browser version](https://fdarkaou.github.io/competitor-media-brief/) that reads pasted JSON and never sends anything anywhere.

```
## Competitor media brief

2 app(s), 3 live ad(s) read, 2 organic match(es). 1 app(s) send some ad clicks to the web. Read 2026-11-12.

### Where the ad clicks go

| App | App Store | Play Store | Web | Unknown | Web share | Live ads read | Longest live (days) | Organic matches |
|---|---|---|---|---|---|---|---|---|
| Example Calories | 14 | 2 | 6 | 1 | 26% | 3 | 190 | 2 |
| Sample Snap Calories | 0 | 0 | 0 | 0 | — | 0 | — | 0 |

### Since the last report

- Example Calories: Web ads 0 → 6
- Example Calories: new ad destination host try.example-calories.com
- Example Calories: new landing page try.example-calories.com/quiz
- Example Calories: 1 new live ad (meta video try.example-calories.com “Scan your plate, get calories in seconds”)
...
```

(Example data from `examples/`, not real apps.)

## Where the data comes from

The data comes from [PeekPanda](https://peekpanda.com), an iOS competitor catalogue where every app has a case file of dated, stored evidence. The tool calls:

- [`GET /v1/competitors/ios/{storeId}/media`](https://peekpanda.com/docs/get-competitor-media) (MCP `get_app`, action `media`, scope `context:read`), one call per app. It returns `paidAdDestinations` (counts for `appStore`, `playStore`, `web` and `unknown`, plus `landingPages`), `paidAds` (the first page of the app's live ads, most recently discovered first, with `items`, `nextCursor` and `hasMore`) and `organic` (the organic-match page: `sourceId`, `productName`, `caption`, `link` and `match` with `status`, `evidence` and `score`, plus `candidateLimitReached`).
- [`GET /v1/paid-ads`](https://peekpanda.com/docs/search-paid-ads) with `storeIds={storeId}&status=active&sort=recently_discovered&cursor={nextCursor}` (MCP `get_ads`, action `search`), only when you pass `--pages 2` or more. This is how the media docs say to continue the live ads page.

How it reads them:

- Destination counts are where the app's stored ads sent their clicks. Only App Store ads count as App Store. Web share is the web count divided by the sum of the four counts.
- From each ad it keeps the platform, format, hook (or title), CTA, destination kind and host, start date, discovery date and the public ad library link. Days live are whole UTC days from the start day to the day of the read, for live ads with a start date.
- Image and video links are left out of the report: PeekPanda's docs describe paid-ad media links as short-lived.
- The live ads list is about a minute behind new ads. An ad shows as "no longer in the live list" only when both runs read the whole list (`hasMore` false); otherwise it may just be on a later page.
- Organic matches are suggestions, tied to the app by App Store link, website or name. They do not prove who owns the post.
- An app with zero stored ads was either never collected or has none stored. That is not proof it runs no ads anywhere.
- There is no spend, impression or reach number here. The ads are public Meta and TikTok ad-library observations, and spend is unavailable unless the public record reports it.
- These reads return stored observations and never start collection.

**Limits.** Every call counts toward your plan's daily API and MCP allowance: 30 calls a day on Peek, 1,000 on Panda, reset at 00:00 UTC (see [plans and refreshes](https://peekpanda.com/docs/plans-and-refreshes); $59 a month for Peek, $99 for Panda). One app with the default `--pages 1` is one call. The tool warns when a run may need more than 30.

## Use it

```bash
git clone https://github.com/fdarkaou/competitor-media-brief && cd competitor-media-brief
export PEEKPANDA_TOKEN=...   # API key from Account → API keys. Keep it out of source control.

node cli.js --app 1000000001 --app https://apps.apple.com/us/app/rival/id1000000002=Rival
node cli.js --app 1000000001,1000000002 --pages 3 --state media-state.json --archive history
node cli.js --app 1000000001 --format csv > media.csv
node cli.js --app 1000000001 --webhook "$SLACK_WEBHOOK_URL"   # Discord webhook URLs work too
```

Try it offline on the bundled example:

```bash
node cli.js --file examples/media.json
cp examples/previous.json /tmp/state.json && node cli.js --file examples/media.json --state /tmp/state.json
npm test
```

Options: `--app` (id or App Store link, optional `=Label`, repeat or comma-separate), `--pages 1–10`, `--state`, `--archive`, `--format md|csv|json`, `--webhook`, `--file`, `--tenancy` (default `personal`), `--api`. The CSV has one row per app × live ad with the app's destination counts and landing pages on every row.

On `429 rate_limited` or `503 timeout` with a short `Retry-After` it waits and retries once. On `429 daily_call_limit` it stops. Other documented errors (`400 invalid_request`, `401 authentication_required`, `402 subscription_required`, `403 authorization_required`, `403 workspace_not_accessible`, `404 not_found`) are printed and stop the run.

## Run it every week

[`.github/workflows/competitor-media-brief.yml`](.github/workflows/competitor-media-brief.yml) runs every Monday, keeps the last report in the Actions cache so each run shows what changed, writes the brief to the job summary and uploads a CSV. It does nothing until you set the repository variable `ENABLE_COMPETITOR_MEDIA_BRIEF=true` and add the secret `PEEKPANDA_TOKEN` (and optionally `COMPETITOR_MEDIA_WEBHOOK_URL`).

## Ask an assistant instead

If your assistant is connected to the PeekPanda MCP server (`https://mcp.peekpanda.com/mcp`, OAuth 2.1 with PKCE S256 and dynamic client registration, scopes `context:read content:write`, or an API key; see [MCP setup](https://peekpanda.com/docs/mcp.md) and the [tool list](https://peekpanda.com/docs/mcp-tools.md)), ask it to call `get_app`:

```json
{ "request": { "action": "media", "params": { "platform": "ios", "storeId": "1000000001" } } }
```

Then ask: "Which of these ads send people to the web instead of the App Store, and since when?"

## Browser version

`index.html` (served on GitHub Pages) takes one or more pasted media responses, or a report saved with `--format json`, and shows the destination split as bars, the landing pages, the live ads table and the organic matches, plus a diff against an older report and a CSV download. It never calls the API, so your key never leaves your machine.

## License

MIT. Example data is made up.
