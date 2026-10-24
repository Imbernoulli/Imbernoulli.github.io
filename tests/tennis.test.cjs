const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pacificClock, nextDates, visibleSlots, validateSnapshot, buildTimeline, courtBookingUrl } = require('../assets/tennis.js');

test('court links target the exact park and individual court, without a shared checkout key', () => {
  const url = new URL(courtBookingUrl('17517', 'Tennis Court #2'));
  assert.equal(url.origin, 'https://ca-berkeley.civicrec.com');
  assert.equal(url.pathname, '/CA/berkeley-ca/catalog');
  const filters = new URLSearchParams(atob(url.searchParams.get('filter')));
  assert.equal(filters.get('tab[7865]'), '1');
  assert.equal(filters.get('location[17517]'), '1');
  assert.equal(filters.get('search'), 'Tennis Court #2');
  assert.notEqual(courtBookingUrl('17517', 'Tennis Court #1'), url.href);
  assert.notEqual(courtBookingUrl('17523', 'Tennis Court #2'), url.href);
  assert.throws(() => courtBookingUrl('', 'Tennis Court #1'));
  assert.throws(() => courtBookingUrl('17517', ''));
});

test('Pacific dates stay correct across UTC midnight and both DST transitions', () => {
  assert.equal(pacificClock(new Date('2026-10-25T01:00:00Z')).date, '2026-10-24');
  assert.equal(pacificClock(new Date('2026-10-25T07:00:00Z')).date, '2026-10-25');
  assert.equal(pacificClock(new Date('2026-03-08T09:59:00Z')).hour, 1);
  assert.equal(pacificClock(new Date('2026-03-08T10:00:00Z')).hour, 3);
  assert.equal(pacificClock(new Date('2026-11-01T08:30:00Z')).hour, 1);
  assert.equal(pacificClock(new Date('2026-11-01T09:30:00Z')).hour, 1);
});

test('three calendar dates include today over DST and year boundaries', () => {
  assert.deepEqual(nextDates('2026-03-07'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(nextDates('2026-10-31'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(nextDates('2026-12-31'), ['2026-12-31', '2027-01-01', '2027-01-02']);
});

test('hide elapsed windows and align current windows to the existing time grid', () => {
  const clock = pacificClock(new Date('2026-10-24T20:30:15Z'));
  const slots = [['07:00', '09:00'], ['13:00', '15:00'], ['17:00', '22:00']];
  assert.deepEqual(visibleSlots(slots, '2026-10-24', clock), [['13:30', '15:00'], ['17:00', '22:00']]);
  assert.deepEqual(visibleSlots(slots, '2026-10-23', clock), []);
  assert.deepEqual(visibleSlots(slots, '2026-10-25', clock), slots);
});

test('timeline merges adjacent identical court groups and preserves changes', () => {
  const parks = { Park: [
    { court: 'Court #1', slots: [['07:00', '09:00']] },
    { court: 'Court #2', slots: [['08:00', '10:00']] },
  ] };
  const { columns } = buildTimeline(parks, '2026-10-25', { date: '2026-10-24', minute: 600 });
  const runs = [...columns[0].runs.values()].filter(run => run.courts.length);
  assert.deepEqual(runs, [
    { start: 420, end: 480, rowSpan: 2, courts: ['Court #1'] },
    { start: 480, end: 540, rowSpan: 2, courts: ['Court #1', 'Court #2'] },
    { start: 540, end: 600, rowSpan: 2, courts: ['Court #2'] },
  ]);
});

test('timeline aligns parks to half-hour rows without inventing current-minute boundaries', () => {
  const parks = {
    First: [{ court: 'Court #1', slots: [['13:00', '15:00']] }],
    Second: [{ court: 'Court #2', slots: [['14:30', '15:00']] }],
    Empty: [{ court: 'Court #1', slots: [] }],
  };
  const { times, columns } = buildTimeline(parks, '2026-10-24', { date: '2026-10-24', minute: 847 });
  assert.ok(!times.includes(847));
  assert.equal(columns.length, 3);
  assert.equal([...columns[0].runs.values()].find(run => run.courts.length).start, 840);
  assert.equal([...columns[1].runs.values()].find(run => run.courts.length).start, 870);
  assert.ok([...columns[2].runs.values()].every(run => run.courts.length === 0));
  for (const column of columns) {
    assert.equal([...column.runs.values()].reduce((sum, run) => sum + run.rowSpan, 0), times.length - 1);
  }
});

test('collapse only intervals with no available courts across every park', () => {
  const parks = {
    First: [{ court: 'Court #1', slots: [['09:00', '10:00']] }],
    Second: [{ court: 'Court #2', slots: [['12:00', '13:00']] }],
  };
  const { times, rows, columns } = buildTimeline(parks, '2026-10-25', { date: '2026-10-24', minute: 600 });
  const gaps = rows.filter(row => row.empty).map(row => [times[row.start], times[row.end]]);
  assert.deepEqual(gaps, [[420, 540], [600, 720], [780, 1320]]);
  for (const row of rows.filter(row => !row.empty)) {
    assert.ok(columns.some(column => [...column.runs.entries()].some(([start, run]) =>
      run.courts.length && start <= row.start && start + run.rowSpan > row.start)));
  }
});

test('map includes every catalog park and a central campus marker', () => {
  const locations = require('../assets/tennis-locations.json');
  const data = require('../assets/tennis-initial.json');
  const parks = Object.keys(Object.values(data.dates)[0]);
  assert.deepEqual(locations.filter(place => !place.campus).map(place => place.name), parks);
  assert.equal(locations.filter(place => place.campus).length, 1);
  assert.equal(locations.find(place => place.campus).landmark, 'Sather Tower');
  for (const place of locations) {
    assert.ok(place.lat > 37.85 && place.lat < 37.90);
    assert.ok(place.lon > -122.31 && place.lon < -122.25);
    assert.ok(place.osm_id);
    if (!place.campus) assert.match(place.civicrec_location_id, /^\d+$/);
  }
});

test('actual initial snapshot is complete and well formed', () => {
  const data = require('../assets/tennis-initial.json');
  assert.equal(validateSnapshot(data), data);
  assert.equal(Object.keys(data.dates).length, 3);
  for (const parks of Object.values(data.dates)) {
    assert.equal(Object.keys(parks).length, 8);
    assert.equal(Object.values(parks).flat().length, 19);
  }
});

test('reject malformed cached or upstream snapshots instead of showing no availability', () => {
  const data = { schema_version: 1, timezone: 'America/Los_Angeles',
    generated_at: '2026-10-24T13:00:00-07:00', dates: {
      '2026-10-24': { Park: [{ court: 'Court 1', slots: [['17:00', '18:00']] }] },
    } };
  assert.equal(validateSnapshot(data), data);
  assert.throws(() => validateSnapshot({ ...data, dates: {} }));
  assert.throws(() => validateSnapshot({ ...data, generated_at: 'bad date' }));
  data.dates['2026-10-24'].Park[0].slots = [['19:00', '18:00']];
  assert.throws(() => validateSnapshot(data));
});
