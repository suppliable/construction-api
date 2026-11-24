'use strict';

// The geofence verdicts and day boundaries are the whole of what makes
// attendance trustworthy, so each is pinned directly.
//
// Desktops have no GPS — they place themselves from nearby Wi-Fi — so accuracy
// of a few hundred metres is normal. The verdict logic has to treat "could not
// tell" as its own answer rather than as a violation.

const {
  shopLocation, radiusMeters, evaluateLocation, validCoords,
  autoOutTime, autoOutInstant, autoOutAt, isStale,
  minutesBetween, formatDuration, formatDistance, describeVerdict,
} = require('../attendanceRules');

const SHOP = { lat: 12.863326, lng: 80.226196 };
const RADIUS = 200;
const opts = { shop: SHOP, radiusM: RADIUS };

// ~111 km per degree of latitude, so these offsets are metres from the shop.
const northOf = metres => ({ lat: SHOP.lat + metres / 111_195, lng: SHOP.lng });
const read = (metres, accuracy) => ({ ...northOf(metres), accuracy });

describe('evaluateLocation', () => {
  test('standing at the shop with a good fix is inside', () => {
    const r = evaluateLocation(read(0, 30), opts);
    expect(r.verdict).toBe('inside');
    expect(r.distanceM).toBeLessThanOrEqual(2);
  });

  test('150 m away with a decent fix is still inside the 200 m fence', () => {
    expect(evaluateLocation(read(150, 40), opts).verdict).toBe('inside');
  });

  test('400 m away with a decent fix is outside', () => {
    const r = evaluateLocation(read(400, 40), opts);
    expect(r.verdict).toBe('outside');
    expect(r.distanceM).toBeGreaterThan(380);
  });

  test('a loose fix close to the shop is UNVERIFIED, not a violation', () => {
    // ±500 m could be anywhere within half a kilometre — saying "outside" would
    // punish someone for their laptop's Wi-Fi positioning.
    const r = evaluateLocation(read(100, 500), opts);
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toBe('low_accuracy');
  });

  test('a loose fix that is wrong even allowing for its error is outside', () => {
    // 5 km away ±500 m cannot be at the shop however generous the margin.
    expect(evaluateLocation(read(5000, 500), opts).verdict).toBe('outside');
  });

  test('the error margin is given as benefit of the doubt, not ignored', () => {
    // 600 m away ±500 m: could really be 100 m away, so not provably outside.
    expect(evaluateLocation(read(600, 500), opts).verdict).toBe('unverified');
  });

  test('no location at all is unverified', () => {
    for (const bad of [undefined, null, {}, { lat: 'x', lng: 'y' }, { lat: NaN, lng: 80 }]) {
      const r = evaluateLocation(bad, opts);
      expect(r.verdict).toBe('unverified');
      expect(r.reason).toBe('no_location');
      expect(r.distanceM).toBeNull();
    }
  });

  test('0,0 is a broken location stack, never the shop', () => {
    expect(evaluateLocation({ lat: 0, lng: 0, accuracy: 10 }, opts).reason).toBe('no_location');
  });

  test('out-of-range coordinates are rejected rather than computed', () => {
    expect(validCoords(91, 80)).toBe(false);
    expect(validCoords(12, 181)).toBe(false);
    expect(validCoords(12.8, 80.2)).toBe(true);
  });

  test('an unknown accuracy cannot be trusted either way', () => {
    const r = evaluateLocation({ ...northOf(10) }, opts);
    expect(r.verdict).toBe('unverified');
    expect(r.reason).toBe('no_accuracy');
  });

  test('NEVER returns the coordinates — a clock-in from home must not store an address', () => {
    const r = evaluateLocation(read(4200, 30), opts);
    expect(Object.keys(r).sort()).toEqual(['accuracyM', 'distanceM', 'reason', 'verdict']);
    expect(JSON.stringify(r)).not.toContain(String(SHOP.lat).slice(0, 5));
  });

  test('the radius is configurable', () => {
    expect(evaluateLocation(read(250, 30), { shop: SHOP, radiusM: 300 }).verdict).toBe('inside');
    expect(evaluateLocation(read(250, 30), { shop: SHOP, radiusM: 200 }).verdict).toBe('outside');
  });
});

describe('shop and radius config', () => {
  test('falls back to the delivery warehouse default when unset', () => {
    expect(shopLocation({})).toEqual({ lat: 12.863326, lng: 80.226196 });
  });
  test('uses WAREHOUSE_LAT/LNG when set', () => {
    expect(shopLocation({ WAREHOUSE_LAT: '13.1', WAREHOUSE_LNG: '80.3' })).toEqual({ lat: 13.1, lng: 80.3 });
  });
  test('radius defaults to 200 and ignores junk', () => {
    expect(radiusMeters({})).toBe(200);
    expect(radiusMeters({ ATTENDANCE_RADIUS_M: 'abc' })).toBe(200);
    expect(radiusMeters({ ATTENDANCE_RADIUS_M: '-5' })).toBe(200);
    expect(radiusMeters({ ATTENDANCE_RADIUS_M: '350' })).toBe(350);
  });
});

describe('auto clock-out', () => {
  test('the cut-off is 20:00 IST, which is 14:30 UTC', () => {
    expect(autoOutInstant('2026-11-24', '20:00')).toBe('2026-11-24T14:30:00.000Z');
  });

  test('the configured time must be HH:MM or it is ignored', () => {
    expect(autoOutTime({})).toBe('20:00');
    expect(autoOutTime({ ATTENDANCE_AUTO_OUT: '19:30' })).toBe('19:30');
    expect(autoOutTime({ ATTENDANCE_AUTO_OUT: '7pm' })).toBe('20:00');
    expect(autoOutTime({ ATTENDANCE_AUTO_OUT: '25:00' })).toBe('20:00');
  });

  const open = date => ({ date, inAt: `${date}T03:30:00.000Z`, outAt: null });

  test('yesterday\'s open record is stale — it can never be clocked out normally again', () => {
    expect(isStale(open('2026-11-23'), new Date('2026-11-24T04:00:00Z'))).toBe(true);
  });

  test('today\'s record is NOT stale before the cut-off', () => {
    // 19:00 IST
    expect(isStale(open('2026-11-24'), new Date('2026-11-24T13:30:00Z'))).toBe(false);
  });

  test('today\'s record IS stale once the cut-off has passed', () => {
    // 20:01 IST
    expect(isStale(open('2026-11-24'), new Date('2026-11-24T14:31:00Z'))).toBe(true);
  });

  test('a closed record is never stale', () => {
    expect(isStale({ ...open('2026-11-20'), outAt: '2026-11-20T12:00:00.000Z' }, new Date('2026-11-24T04:00:00Z'))).toBe(false);
  });

  test('the date rolls over at IST midnight, not UTC', () => {
    // 00:10 IST on the 25th is still the 24th in UTC. The 24th's record must be
    // stale; judging by UTC would give it another 18 hours.
    expect(isStale(open('2026-11-24'), new Date('2026-11-24T18:40:00Z'))).toBe(true);
  });

  test('auto clock-out is stamped at the cut-off', () => {
    expect(autoOutAt(open('2026-11-24'))).toBe('2026-11-24T14:30:00.000Z');
  });

  test('never earlier than the clock-in — a late arrival must not get a negative day', () => {
    const late = { date: '2026-11-24', inAt: '2026-11-24T15:00:00.000Z', outAt: null }; // 20:30 IST
    expect(autoOutAt(late)).toBe('2026-11-24T15:00:00.000Z');
    expect(minutesBetween(late.inAt, autoOutAt(late))).toBe(0);
  });
});

describe('durations', () => {
  test('minutes between two instants', () => {
    expect(minutesBetween('2026-11-24T03:32:00.000Z', '2026-11-24T13:18:00.000Z')).toBe(586);
  });
  test('open or reversed intervals have no duration, not a negative one', () => {
    expect(minutesBetween('2026-11-24T03:00:00.000Z', null)).toBeNull();
    expect(minutesBetween('2026-11-24T10:00:00.000Z', '2026-11-24T09:00:00.000Z')).toBeNull();
  });
  test('formats hours and minutes', () => {
    expect(formatDuration(586)).toBe('9h 46m');
    expect(formatDuration(65)).toBe('1h 05m');
    expect(formatDuration(42)).toBe('42m');
    expect(formatDuration(null)).toBe('—');
  });
  test('formats distance in metres under a km, km above', () => {
    expect(formatDistance(180)).toBe('180 m');
    expect(formatDistance(4200)).toBe('4.2 km');
  });
});

describe('describeVerdict', () => {
  test('an inside clock-in has nothing to say', () => {
    expect(describeVerdict({ verdict: 'inside' })).toBeNull();
  });
  test('outside names the distance', () => {
    expect(describeVerdict({ verdict: 'outside', distanceM: 4200 })).toBe('Outside geofence — 4.2 km away');
  });
  test('unverified says WHY, so "denied" and "too imprecise" are not conflated', () => {
    expect(describeVerdict({ verdict: 'unverified', reason: 'no_location' })).toMatch(/unavailable or permission denied/);
    expect(describeVerdict({ verdict: 'unverified', reason: 'low_accuracy', accuracyM: 800 })).toMatch(/too imprecise.*800 m/);
  });
});
