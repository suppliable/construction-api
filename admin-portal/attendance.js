// Attendance: the clock-in prompt and the "In since 9:02 AM" indicator, shared by
// every admin page.
//
// Does NOTHING for anyone without attendance switched on — no request, no
// location prompt. The flag it reads is cached from login purely so ordinary
// users pay nothing; the server re-checks it on every call, so a stale copy can
// only ever make this script do less, never grant anything.
//
// Clock-in is "first login of the day", and the server makes it idempotent. The
// portal keeps its token per browser tab, so people sign in again on every new
// tab; calling clock-in on every page load is therefore safe and intended.
(function () {
  'use strict';

  var token = sessionStorage.getItem('adminToken');
  if (!token) return;

  var user = {};
  try { user = JSON.parse(sessionStorage.getItem('adminUser') || '{}'); } catch (e) { /* treated as not enabled */ }
  if (!user.attendanceEnabled) return;

  var API = '/api/v1/admin/attendance';
  var host = document.querySelector('.sidebar-brand');
  if (!host) return;

  var pill = document.createElement('div');
  pill.id = 'attPill';
  pill.style.cssText = 'margin-top:10px;font-size:12px;line-height:1.5;color:rgba(255,255,255,.78);';
  pill.textContent = '…';
  host.appendChild(pill);

  function call(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); });
  }

  // Resolves to {lat,lng,accuracy}, or {} when location is denied or unavailable.
  // A refusal is a normal outcome that must still produce a (flagged) clock-in,
  // so this never rejects.
  function position(timeoutMs) {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
        function () { resolve({}); },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 }
      );
    });
  }

  function clock(iso) {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }).toUpperCase();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var BTN = 'margin-left:8px;padding:2px 9px;border-radius:6px;border:1px solid rgba(255,255,255,.35);' +
            'background:transparent;color:#fff;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;';

  function render(record) {
    if (!record) { pill.textContent = '⚪ Not clocked in'; return; }

    // Surface a flagged clock-in to the person themselves, so it is never a
    // surprise that the channel saw it.
    var flag = record.inNote
      ? '<div style="color:#fbbf24;font-size:11px;" title="' + esc(record.inNote) + '">⚠️ ' + esc(record.inNote) + '</div>'
      : '';

    if (record.outAt) {
      pill.innerHTML = '⚪ Out at ' + clock(record.outAt) + ' · ' + esc(record.duration) + flag;
      return;
    }
    pill.innerHTML = '🟢 In since ' + clock(record.inAt) +
      '<button id="attOut" style="' + BTN + '">Clock out</button>' + flag;
    document.getElementById('attOut').addEventListener('click', clockOut);
  }

  function clockOut() {
    if (!window.confirm('Clock out now?')) return;
    var btn = document.getElementById('attOut');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    // Best effort and short: clock-out records where you were but never depends
    // on it, so a slow location fix must not delay leaving.
    position(6000)
      .then(function (pos) { return call('POST', '/clock-out', pos); })
      .then(function (res) {
        if (res.success) render(res.data.record);
        else { window.alert(res.message || 'Could not clock out'); redraw(); }
      })
      .catch(function () { window.alert('Could not clock out — check your connection.'); redraw(); });
  }

  // Resolves to null when attendance is off for this person, otherwise to
  // { record } — where record is itself null before the first clock-in of the
  // day. Those are different answers and must not share a value: returning the
  // bare record made "on, not clocked in yet" look like "off", so the script
  // stopped before ever asking for location.
  function refresh() {
    return call('GET', '/me').then(function (res) {
      if (!res.success || !res.data.enabled) { pill.remove(); return null; }
      return { record: res.data.record };
    });
  }

  function redraw() {
    return refresh().then(function (state) { if (state) render(state.record); });
  }

  refresh().then(function (state) {
    if (state === null) return;
    if (state.record) return render(state.record);

    // First load of the day: ask where we are, then clock in.
    pill.textContent = '📍 Clocking in…';
    return position(15000)
      .then(function (pos) { return call('POST', '/clock-in', pos); })
      .then(function (res) {
        if (res.success) render(res.data.record);
        else pill.textContent = '⚠️ ' + (res.message || 'Clock-in failed');
      });
  }).catch(function () { pill.textContent = '⚠️ Attendance unavailable'; });
})();
