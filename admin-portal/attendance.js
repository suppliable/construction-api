// Attendance: the clock-in prompt and the "In since 9:02 AM" indicator, shared by
// every admin page.
//
// Does NOTHING for anyone without attendance switched on — no request, no
// location prompt. The flag it reads is cached from login purely so ordinary
// users pay nothing; the server re-checks it on every call, so a stale copy can
// only ever make this script do less, never grant anything.
//
// Clock-in is a button the person presses. Until they do, a full-screen prompt
// covers the page and cannot be dismissed — and the SERVER refuses every admin
// call from them (403 ATTENDANCE_REQUIRED), so removing the prompt in dev tools
// gets them a page that loads nothing. This script is the courtesy; the gate is
// middleware/requireClockIn.js. Clock-in is idempotent per day, so pressing it
// from two tabs is still one arrival.
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

  // One place decides what is on screen for a given state, so a failed clock-in
  // brings the prompt back rather than leaving a bare label.
  function present(state) {
    if (state === null) return;                 // attendance is off for this person
    closeModal();
    if (state.record) return render(state.record);
    showNotClockedIn();
    showPrompt();
  }
  function redraw() { return refresh().then(present); }

  var modal = null;
  function closeModal() { if (modal) { modal.remove(); modal = null; } }

  // Pressed from either the prompt or the sidebar. Location is asked here, on a
  // click, so the browser's permission dialog is tied to something the person
  // just did. A refusal still clocks in, flagged — see position().
  function clockIn() {
    closeModal();
    pill.textContent = '📍 Getting your location…';
    return position(15000)
      .then(function (pos) { return call('POST', '/clock-in', pos); })
      .then(function (res) {
        if (res.success) {
          render(res.data.record);
          // Whatever the page asked for before this moment was refused (the
          // server locks the API until clock-in), so load it again now.
          window.location.reload();
        } else { window.alert(res.message || 'Clock-in failed'); redraw(); }
      })
      .catch(function () { window.alert('Could not clock in — check your connection.'); redraw(); });
  }

  function showNotClockedIn() {
    pill.innerHTML = '⚪ Not clocked in<button id="attIn" style="' + BTN + '">Clock in</button>';
    document.getElementById('attIn').addEventListener('click', clockIn);
  }

  function showPrompt() {
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
      '<div style="background:#fff;color:#111827;border-radius:14px;padding:26px 28px;max-width:380px;width:100%;' +
      'box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:inherit;">' +
      '<div style="font-size:19px;font-weight:700;margin-bottom:6px;">Good day, ' + esc(user.name || '') + '</div>' +
      '<div style="font-size:14px;color:#4b5563;line-height:1.5;margin-bottom:20px;">' +
      'Clock in to start your day — the portal opens once you have. Your browser will ask ' +
      'to share your location; it is only used to check you are at the shop.</div>' +
      '<div style="display:flex;">' +
      '<button id="attModalIn" style="flex:1;padding:11px;border:0;border-radius:9px;background:#16a34a;color:#fff;' +
      'font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">🟢 Clock in</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    document.getElementById('attModalIn').addEventListener('click', clockIn);
  }

  refresh().then(present).catch(function () { pill.textContent = '⚠️ Attendance unavailable'; });
})();
