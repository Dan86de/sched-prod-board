import { ack, fetchIncidents } from './api.js';
import { SESSION } from './config.js';

const REFRESH_MS = 2000;

const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const list = document.querySelector('[data-testid="incident-list"]');
const status = document.querySelector('[data-role="status"]');

const timeFormat = new Intl.DateTimeFormat(navigator.language, {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
const clockFormat = new Intl.DateTimeFormat(navigator.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Acks survive a reload of the board: incident id -> ackedAt. */
const ackedKey = `acked:${SESSION}`;
const acked = new Map(readAcked());

function readAcked() {
  try {
    return Object.entries(JSON.parse(localStorage.getItem(ackedKey)) ?? {});
  } catch {
    return [];
  }
}

function saveAcked() {
  try {
    localStorage.setItem(ackedKey, JSON.stringify(Object.fromEntries(acked)));
  } catch {
    // Storage is a convenience; the board works without it.
  }
}

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}

function ackedMark(ackedAt) {
  return el('span', { 'data-testid': 'acked', class: 'acked' }, `acked ${formatTime(ackedAt)}`);
}

function ackButton(id) {
  const button = el('button', { type: 'button', 'data-testid': 'ack', class: 'ack' }, 'Ack');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Acking…';
    try {
      const reply = await ack(id);
      acked.set(id, reply.ackedAt);
      saveAcked();
      button.replaceWith(ackedMark(reply.ackedAt));
    } catch (error) {
      console.error(error);
      button.disabled = false;
      button.textContent = 'Retry ack';
    }
  });
  return button;
}

function createRow(incident) {
  const row = el('li', { 'data-testid': 'incident-row', 'data-id': incident.id, class: `row ${incident.severity}` });
  const time = el('time', { datetime: incident.openedAt }, formatTime(incident.openedAt));
  time.title = incident.openedAt;
  row.append(
    el('span', { class: 'id' }, incident.id),
    el('span', { class: 'sev' }, incident.severity),
    el('span', { class: 'what' }, `${incident.service} · ${incident.region} · ${incident.summary}`),
    time,
    acked.has(incident.id) ? ackedMark(acked.get(incident.id)) : ackButton(incident.id),
  );
  return row;
}

/** Keeps existing rows (and their ack state) in place; adds new ones in API order, newest first. */
function render(incidents, firstRender) {
  const rows = new Map([...list.children].map((row) => [row.dataset.id, row]));
  const seen = new Set();
  let previous = null;
  for (const incident of incidents) {
    seen.add(incident.id);
    let row = rows.get(incident.id);
    if (!row) {
      row = createRow(incident);
      if (!firstRender) row.classList.add('new');
    }
    const expectedPosition = previous ? previous.nextElementSibling : list.firstElementChild;
    if (row !== expectedPosition) list.insertBefore(row, expectedPosition);
    previous = row;
  }
  for (const [id, row] of rows) if (!seen.has(id)) row.remove();

  loader.hidden = true;
  empty.hidden = incidents.length > 0;
  list.hidden = incidents.length === 0;
}

let firstRender = true;
async function refresh() {
  try {
    const page = await fetchIncidents();
    render(page.incidents, firstRender);
    firstRender = false;
    status.textContent = `· live, updated ${clockFormat.format(page.updatedAt ? new Date(page.updatedAt) : new Date())}`;
    status.classList.remove('stale');
  } catch (error) {
    console.error(error);
    status.textContent = '· connection lost, retrying';
    status.classList.add('stale');
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
