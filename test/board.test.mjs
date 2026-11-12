// Drives the built board in Chromium against a fake incident API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let server;
let origin;
let browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      const body = await readFile(join('dist', path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': types[extname(path || '.html')] ?? 'text/html' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

const incident = (id, openedAt, summary = 'webhook retries piling up') => ({
  id, service: 'auth', region: 'eu-west', summary, severity: 'sev2', openedAt,
});

/** A fake API: `state.incidents` is what the next poll answers; acks are recorded. */
async function openBoard(state, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  state.acks = [];
  state.polls = 0;
  await page.route('**/challenges/show-me-when/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/incidents')) {
      state.polls += 1;
      if (state.hold) await state.hold;
      return route.fulfill({ json: { updatedAt: new Date().toISOString(), incidents: state.incidents, cursor: `c${state.polls}` } });
    }
    const id = url.searchParams.get('id');
    state.acks.push({ id, cursor: url.searchParams.get('cursor') });
    return route.fulfill({ json: { id, ackedAt: '2026-11-12T03:05:00.000Z', receipt: `r-${id}` } });
  });
  await page.goto(origin);
  return { page, context };
}

const rowIds = (page) => page.locator('[data-testid="incident-row"]').evaluateAll((rows) => rows.map((r) => r.dataset.id));

test('names its build in the head and the footer (R6)', async () => {
  const { page, context } = await openBoard({ incidents: [] });
  const meta = await page.locator('meta[name="build"]').getAttribute('content');
  assert.match(meta, /^[0-9a-f]{40}$/);
  assert.equal(await page.locator('[data-testid="build-sha"]').textContent(), meta);
  await context.close();
});

test('shows the loader until incidents load, then the list (R3)', async () => {
  let release;
  const state = { incidents: [incident('INC-1', '2026-11-12T03:03:00.000Z')], hold: new Promise((r) => { release = r; }) };
  const { page, context } = await openBoard(state);
  await page.locator('[data-testid="loader"]').waitFor({ state: 'visible' });
  release();
  state.hold = null;
  await page.locator('[data-testid="incident-row"]').waitFor();
  assert.equal(await page.locator('[data-testid="loader"]').isVisible(), false);
  await context.close();
});

test('shows the empty state when there are no incidents', async () => {
  const { page, context } = await openBoard({ incidents: [] });
  await page.locator('[data-testid="empty"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-testid="loader"]').isVisible(), false);
  await context.close();
});

test('new incidents appear at the top without a reload, refreshing every 2 s (R1, R4)', async () => {
  const state = { incidents: [incident('INC-1', '2026-11-12T03:03:00.000Z')] };
  const { page, context } = await openBoard(state);
  await page.locator('[data-testid="incident-row"]').waitFor();
  state.incidents = [incident('INC-2', '2026-11-12T03:10:00.000Z'), ...state.incidents];
  const started = Date.now();
  await page.locator('[data-testid="incident-row"][data-id="INC-2"]').waitFor({ timeout: 4000 });
  assert.ok(Date.now() - started < 3500, 'picked up within one refresh');
  assert.deepEqual(await rowIds(page), ['INC-2', 'INC-1']);
  await context.close();
});

test('Ack acks that incident with the latest cursor and keeps the mark across refreshes (R2)', async () => {
  const state = { incidents: [incident('INC-2', '2026-11-12T03:10:00.000Z'), incident('INC-1', '2026-11-12T03:03:00.000Z')] };
  const { page, context } = await openBoard(state);
  await page.locator('[data-id="INC-1"] [data-testid="ack"]').click();
  await page.locator('[data-id="INC-1"] [data-testid="acked"]').waitFor();
  assert.equal(state.acks.length, 1);
  assert.equal(state.acks[0].id, 'INC-1');
  assert.equal(state.acks[0].cursor, `c${state.polls}`);
  state.incidents = [incident('INC-3', '2026-11-12T03:20:00.000Z'), ...state.incidents];
  await page.locator('[data-id="INC-3"]').waitFor({ timeout: 4000 });
  assert.equal(await page.locator('[data-id="INC-1"] [data-testid="acked"]').count(), 1);
  assert.equal(await page.locator('[data-id="INC-2"] [data-testid="ack"]').count(), 1);
  await context.close();
});

test('renders summaries as text, not markup', async () => {
  const state = { incidents: [incident('INC-1', '2026-11-12T03:03:00.000Z', '<img src=x onerror="window.pwned=1">')] };
  const { page, context } = await openBoard(state);
  await page.locator('[data-testid="incident-row"]').waitFor();
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await context.close();
});

for (const [zone, locale, expected] of [
  ['Pacific/Auckland', 'en-NZ', /^12\/11.*4:03/],
  ['Europe/Berlin', 'de-DE', /^12\.11\..*04:03/],
  ['America/New_York', 'en-US', /^11\/11.*10:03/],
]) {
  test(`times show in local time, in the viewer's order: ${zone} ${locale} (R5)`, async () => {
    const at = { 'Pacific/Auckland': '2026-11-11T15:03:00.000Z', 'Europe/Berlin': '2026-11-12T03:03:00.000Z', 'America/New_York': '2026-11-12T03:03:00.000Z' }[zone];
    const state = { incidents: [incident('INC-1', at)] };
    const { page, context } = await openBoard(state, { timezoneId: zone, locale });
    const time = page.locator('[data-testid="incident-row"] time');
    await time.waitFor();
    assert.match(await time.textContent(), expected);
    assert.equal(await time.getAttribute('datetime'), at);
    await context.close();
  });
}
