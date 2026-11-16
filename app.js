'use strict';

// index.html already showed the reason on screen if the settings were wrong.
if (window.__bootFailed) throw new Error('GoEmb Admin did not start. See the message on the page.');

// ---------------------------------------------------------------------------
// Setup and helpers
// ---------------------------------------------------------------------------
const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const state = { profile: null, cleanup: null };

const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => 'Rs. ' + Number(n || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = s => s ? new Date(s).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' }) : '-';
const dOnly = s => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-LK', { timeZone: 'UTC', dateStyle: 'medium' }) : '-';
const sum = (rows, f) => rows.reduce((a, r) => a + Number(f(r) || 0), 0);

const VEHICLES = { tuk: 'Tuk', bike: 'Bike', car: 'Car', van: 'Van', small_lorry: 'Small lorry' };
const TRIP_STATUS = {
  requested: 'Requested', accepted: 'Accepted', arrived: 'Arrived', in_progress: 'In progress',
  completed: 'Completed', cancelled_by_customer: 'Cancelled (customer)',
  cancelled_by_driver: 'Cancelled (driver)', no_drivers: 'No drivers'
};
const ACTIVE = ['requested', 'accepted', 'arrived', 'in_progress'];
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const tripBadge = s => badge(TRIP_STATUS[s] || s, s === 'completed' ? 'ok' : ACTIVE.includes(s) ? 'warn' : 'bad');
const isAdmin = () => !!state.profile && state.profile.role === 'admin';

// Sri Lanka time (UTC+5:30, no daylight saving)
const colomboNow = () => new Date(Date.now() + 19800000);
const colomboToday = () => colomboNow().toISOString().slice(0, 10);
const colomboDayStart = () => {
  const n = colomboNow();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - 19800000).toISOString();
};
const monthRange = ym => {
  const [y, m] = ym.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1) - 19800000).toISOString(), new Date(Date.UTC(y, m, 1) - 19800000).toISOString()];
};
const dayRange = (from, to) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return [new Date(Date.UTC(fy, fm - 1, fd) - 19800000).toISOString(), new Date(Date.UTC(ty, tm - 1, td + 1) - 19800000).toISOString()];
};
const daysAgo = n => new Date(Date.now() + 19800000 - n * 86400000).toISOString().slice(0, 10);

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = ''; }, 3500);
}
const err = e => toast((e && e.message) || String(e), true);

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = html;
  m.onclick = null;
  m.onchange = null;
  if (!m.open) m.showModal();
  return m;
}
const closeModal = () => { const m = $('#modal'); if (m.open) m.close(); };
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// Reads every row, 1000 at a time (Supabase returns at most 1000 per request).
async function fetchAll(build) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await build().range(i, i + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const table = (heads, rows) =>
  `<div class="tw"><table><thead><tr>${heads.map(h => `<th${h.startsWith('#') ? ' class="n"' : ''}>${h.replace(/^#/, '')}</th>`).join('')}</tr></thead>` +
  `<tbody>${rows.join('') || `<tr><td colspan="${heads.length}" class="muted">Nothing to show</td></tr>`}</tbody></table></div>`;

function downloadCSV(name, rows) {
  const cell = v => {
    let s = typeof v === 'number' ? String(v) : String(v ?? '');
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop spreadsheet formulas
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const PAGES = [
  ['dashboard', 'Dashboard', pageDashboard],
  ['live', 'Live map', pageLive],
  ['drivers', 'Drivers', pageDrivers],
  ['customers', 'Customers', pageCustomers],
  ['trips', 'Trips', pageTrips],
  ['statements', 'Statements', pageStatements],
  ['balances', 'Driver balances', pageBalances],
  ['reports', 'Reports', pageReports],
  ['fares', 'Fares', pageFares],
  ['settings', 'Billing settings', pageSettings]
];

// ---- Dashboard -------------------------------------------------------------
async function pageDashboard(el) {
  const head = (t, f) => { const q = sb.from(t).select('*', { count: 'exact', head: true }); return f(q); };
  const [online, pending, active, today, bal] = await Promise.all([
    head('drivers', q => q.eq('is_online', true)),
    head('drivers', q => q.eq('status', 'pending')),
    head('trips', q => q.in('status', ACTIVE)),
    sb.from('trips').select('status,total_fare,commission_amount').gte('requested_at', colomboDayStart()),
    sb.from('driver_balances').select('outstanding,blocked')
  ]);
  for (const r of [online, pending, active, today, bal]) if (r.error) throw r.error;

  const done = today.data.filter(t => t.status === 'completed');
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  el.innerHTML = `<div class="bar"><h1>Dashboard</h1></div>
    <div class="cards">
      ${stat(online.count, 'Drivers online')}
      ${stat(active.count, 'Active trips')}
      ${stat(pending.count, 'Drivers waiting for approval')}
      ${stat(done.length, 'Trips completed today')}
      ${stat(money(sum(done, t => t.total_fare)), 'Cash fares today')}
      ${stat(money(sum(done, t => t.commission_amount)), 'Commission earned today')}
      ${stat(money(sum(bal.data, r => r.outstanding)), 'Commission owed by drivers')}
      ${stat(bal.data.filter(r => r.blocked).length, 'Drivers blocked for non-payment')}
    </div>`;
}

// ---- Live map --------------------------------------------------------------
async function pageLive(el) {
  el.innerHTML = `<div class="bar"><h1>Live map</h1><span id="cnt" class="muted"></span></div><div id="map"></div>`;
  const map = L.map('map').setView([6.3333, 80.85], 13);   // Embilipitiya
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let fitted = false;

  async function load() {
    const [d, t] = await Promise.all([sb.from('live_drivers').select('*'), sb.from('live_trips').select('*')]);
    if (d.error || t.error) return err(d.error || t.error);
    layer.clearLayers();
    const pts = [];
    d.data.forEach(x => {
      pts.push([x.lat, x.lng]);
      L.circleMarker([x.lat, x.lng], { radius: 9, color: '#4f1c79', fillColor: '#8a55c9', fillOpacity: .9 })
        .bindPopup(`<b>${esc(x.full_name || 'Driver')}</b><br>${esc(VEHICLES[x.vehicle_type] || '')} ${esc(x.plate || '')}<br>${esc(x.phone || '')}<br><small>Updated ${esc(dt(x.updated_at))}</small>`)
        .addTo(layer);
    });
    t.data.forEach(x => {
      pts.push([x.lat, x.lng]);
      L.circleMarker([x.lat, x.lng], { radius: 8, color: '#b58900', fillColor: '#f5c405', fillOpacity: .9 })
        .bindPopup(`<b>Trip pickup</b><br>${esc(TRIP_STATUS[x.status] || x.status)} (${esc(VEHICLES[x.vehicle] || '')})<br>${esc(x.pickup_address || '')}`)
        .addTo(layer);
    });
    $('#cnt').textContent = `${d.data.length} drivers online, ${t.data.length} active trips`;
    if (!fitted && pts.length) { map.fitBounds(pts, { maxZoom: 15, padding: [40, 40] }); fitted = true; }
  }

  let timer;
  const soon = () => { clearTimeout(timer); timer = setTimeout(load, 2500); };
  const ch = sb.channel('live-map')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_locations' }, soon)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, soon)
    .subscribe();
  const poll = setInterval(load, 30000);
  state.cleanup = () => { clearTimeout(timer); clearInterval(poll); sb.removeChannel(ch); map.remove(); };
  await load();
}

// ---- Drivers ---------------------------------------------------------------
async function pageDrivers(el) {
  const { data, error } = await sb.from('drivers')
    .select('*, profiles(full_name,phone), vehicles(type,plate)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  el.innerHTML = `<div class="bar"><h1>Drivers</h1>
    <select id="f"><option value="">All statuses</option>${['pending', 'approved', 'suspended', 'rejected'].map(s => `<option>${s}</option>`).join('')}</select>
    <input id="q" type="search" placeholder="Search name, phone, plate"></div><div id="list"></div>`;
  const draw = () => {
    const f = $('#f').value, q = $('#q').value.trim().toLowerCase();
    const rows = data
      .filter(d => (!f || d.status === f) &&
        (!q || [d.profiles?.full_name, d.profiles?.phone, ...(d.vehicles || []).map(v => v.plate)].join(' ').toLowerCase().includes(q)))
      .map(d => `<tr class="click" data-id="${esc(d.id)}">
        <td>${esc(d.profiles?.full_name || '-')}<div class="muted">${esc(d.profiles?.phone || '')}</div></td>
        <td>${(d.vehicles || []).map(v => esc(VEHICLES[v.type]) + ' ' + esc(v.plate)).join('<br>') || '-'}</td>
        <td>${badge(d.status, d.status === 'approved' ? 'ok' : d.status === 'pending' ? 'warn' : 'bad')}</td>
        <td>${d.is_online ? badge('Online', 'ok') : '<span class="muted">Offline</span>'}</td>
        <td>${esc(d.plan)}</td>
        <td>${Number(d.rating_avg).toFixed(2)} <span class="muted">(${d.rating_count})</span></td></tr>`);
    $('#list').innerHTML = table(['Driver', 'Vehicle', 'Status', 'Online', 'Plan', 'Rating'], rows);
  };
  $('#f').onchange = draw;
  $('#q').oninput = draw;
  $('#list').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) driverDetail(tr.dataset.id); };
  draw();
}

async function driverDetail(id) {
  const [d, docs, veh, chg, bal, stm] = await Promise.all([
    sb.from('drivers').select('*, profiles(full_name,phone)').eq('id', id).single(),
    sb.from('driver_documents').select('*').eq('driver_id', id).order('uploaded_at'),
    sb.from('vehicles').select('*').eq('driver_id', id),
    sb.from('driver_plan_changes').select('*').eq('driver_id', id).eq('status', 'pending'),
    sb.from('driver_balances').select('outstanding,blocked').eq('driver_id', id).maybeSingle(),
    sb.from('monthly_statements').select('*').eq('driver_id', id).order('period_start', { ascending: false }).limit(6)
  ]);
  for (const r of [d, docs, veh, chg, bal, stm]) if (r.error) return err(r.error);
  const x = d.data;
  const urls = await Promise.all(docs.data.map(o => sb.storage.from('driver-docs').createSignedUrl(o.storage_path, 600)));
  const acts = {
    pending: [['approved', 'Approve', 'primary'], ['rejected', 'Reject', 'danger']],
    approved: [['suspended', 'Suspend', 'danger']],
    suspended: [['approved', 'Reactivate', 'primary']],
    rejected: [['approved', 'Approve', 'primary']]
  }[x.status] || [];

  const m = openModal(`
    <div class="head"><div><h1>${esc(x.profiles?.full_name || 'Driver')}</h1><span class="muted">${esc(x.profiles?.phone || '')}</span></div>
      <button data-close>Close</button></div>
    <dl>
      <dt>Status</dt><dd>${badge(x.status, x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : 'bad')} ${x.is_online ? badge('Online', 'ok') : ''}</dd>
      <dt>NIC</dt><dd>${esc(x.nic || '-')}</dd>
      <dt>Licence no.</dt><dd>${esc(x.licence_no || '-')}</dd>
      <dt>Commission plan</dt><dd>${esc(x.plan)}${chg.data.length ? `<div class="muted">Switching to ${esc(chg.data[0].requested_plan)} on ${esc(dOnly(chg.data[0].effective_from))}</div>` : ''}</dd>
      <dt>Rating</dt><dd>${Number(x.rating_avg).toFixed(2)} (${x.rating_count} ratings)</dd>
      <dt>Amount owed</dt><dd>${money(bal.data?.outstanding)} ${bal.data?.blocked ? badge('Blocked', 'bad') : ''}</dd>
      <dt>Registered</dt><dd>${esc(dt(x.created_at))}</dd>
    </dl>
    <h2>Vehicles</h2>
    ${veh.data.map(v => `<div>${esc(VEHICLES[v.type])} &middot; ${esc(v.plate)} &middot; ${esc(v.make_model || '')}</div>`).join('') || '<p class="muted">None</p>'}
    <h2>Documents</h2>
    ${docs.data.map((o, i) => {
      const u = urls[i].data?.signedUrl;
      return `<div><label style="display:flex;gap:.5rem;align-items:center;color:inherit">
        <input type="checkbox" data-doc="${esc(o.id)}" ${o.verified ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}>
        ${esc(o.doc_type)} ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">View</a>` : '<span class="muted">(unavailable)</span>'}
        <span class="muted">${esc(dt(o.uploaded_at))}</span></label></div>`;
    }).join('') || '<p class="muted">No documents uploaded</p>'}
    <h2>Recent statements</h2>
    ${stm.data.map(s => `<div>${esc(dOnly(s.period_start))}: ${money(s.total_due)} ${badge(s.status, s.status === 'paid' ? 'ok' : 'warn')}</div>`).join('') || '<p class="muted">None yet</p>'}
    ${isAdmin() && acts.length ? `<div class="actions">${acts.map(a => `<button class="${a[2]}" data-st="${a[0]}">${a[1]}</button>`).join('')}</div>` : ''}`);

  m.onclick = e => {
    if (e.target.closest('[data-close]')) return closeModal();
    const b = e.target.closest('[data-st]');
    if (b) setDriverStatus(id, b.dataset.st);
  };
  m.onchange = async e => {
    const c = e.target.closest('[data-doc]');
    if (!c) return;
    const { error } = await sb.from('driver_documents').update({ verified: c.checked }).eq('id', c.dataset.doc);
    if (error) err(error);
  };
}

async function setDriverStatus(id, status) {
  const patch = { status };
  if (status !== 'approved') patch.is_online = false;
  const { error } = await sb.from('drivers').update(patch).eq('id', id);
  if (error) return err(error);
  toast('Driver ' + status);
  closeModal();
  route();
}

// ---- Customers -------------------------------------------------------------
async function pageCustomers(el) {
  const rows = await fetchAll(() => sb.from('profiles').select('id,full_name,phone,created_at').eq('role', 'customer').order('created_at', { ascending: false }).order('id'));
  el.innerHTML = `<div class="bar"><h1>Customers</h1><span class="muted">${rows.length} total</span><input id="q" type="search" placeholder="Search name or phone"></div><div id="list"></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    $('#list').innerHTML = table(['Name', 'Phone', 'Joined'],
      rows.filter(r => !q || [r.full_name, r.phone].join(' ').toLowerCase().includes(q))
        .slice(0, 500)
        .map(r => `<tr><td>${esc(r.full_name || '-')}</td><td>${esc(r.phone || '-')}</td><td>${esc(dt(r.created_at))}</td></tr>`));
  };
  $('#q').oninput = draw;
  draw();
}

// ---- Trips -----------------------------------------------------------------
async function pageTrips(el) {
  el.innerHTML = `<div class="bar"><h1>Trips</h1>
    <input id="from" type="date" value="${daysAgo(30)}"><input id="to" type="date" value="${colomboToday()}">
    <select id="f"><option value="">All statuses</option>${Object.entries(TRIP_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <input id="q" type="search" placeholder="Search name or address">
    <button id="csv">Export CSV</button></div><div id="list"><p class="muted">Loading…</p></div>`;
  let trips = [];
  const draw = () => {
    const f = $('#f').value, q = $('#q').value.trim().toLowerCase();
    const shown = trips.filter(t => (!f || t.status === f) &&
      (!q || [t.customer?.full_name, t.driver?.profiles?.full_name, t.pickup_address, t.dropoff_address].join(' ').toLowerCase().includes(q)));
    draw.shown = shown;
    $('#list').innerHTML = table(['Requested', 'Customer', 'Driver', 'Vehicle', 'Status', 'Route', '#Fare', '#Commission'],
      shown.slice(0, 300).map(t => `<tr class="click" data-id="${esc(t.id)}">
        <td>${esc(dt(t.requested_at))}</td><td>${esc(t.customer?.full_name || '-')}</td><td>${esc(t.driver?.profiles?.full_name || '-')}</td>
        <td>${esc(VEHICLES[t.vehicle])}</td><td>${tripBadge(t.status)}</td>
        <td>${esc(t.pickup_address || '')}<div class="muted">to ${esc(t.dropoff_address || '')}</div></td>
        <td class="n">${t.total_fare != null ? money(t.total_fare) : '-'}</td><td class="n">${t.status === 'completed' ? money(t.commission_amount) : '-'}</td></tr>`))
      + (shown.length > 300 ? `<p class="muted">Showing the first 300 of ${shown.length}. Narrow the dates or export the CSV for everything.</p>` : '');
  };
  const load = async () => {
    const [a, b] = dayRange($('#from').value, $('#to').value);
    try {
      trips = await fetchAll(() => sb.from('trips')
        .select('*, customer:profiles!customer_id(full_name,phone), driver:drivers(profiles(full_name,phone))')
        .gte('requested_at', a).lt('requested_at', b).order('requested_at', { ascending: false }).order('id'));
      draw();
    } catch (e) { err(e); }
  };
  $('#from').onchange = $('#to').onchange = load;
  $('#f').onchange = draw;
  $('#q').oninput = draw;
  $('#csv').onclick = () => downloadCSV('goemb-trips.csv', [
    ['Requested', 'Customer', 'Driver', 'Vehicle', 'Status', 'Pickup', 'Dropoff', 'Distance km', 'Fare', 'Loading', 'Total', 'Plan', 'Commission'],
    ...(draw.shown || []).map(t => [dt(t.requested_at), t.customer?.full_name, t.driver?.profiles?.full_name, VEHICLES[t.vehicle], TRIP_STATUS[t.status],
      t.pickup_address, t.dropoff_address, t.distance_km, t.fare, t.loading_charge, t.total_fare, t.commission_plan, t.commission_amount])
  ]);
  $('#list').onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    const t = tr && trips.find(x => x.id === tr.dataset.id);
    if (t) tripDetail(t);
  };
  await load();
}

function tripDetail(t) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const m = openModal(`<div class="head"><h1>Trip</h1><button data-close>Close</button></div><dl>
    ${row('Status', tripBadge(t.status))}
    ${row('Customer', esc(t.customer?.full_name || '-') + ' ' + esc(t.customer?.phone || ''))}
    ${row('Driver', esc(t.driver?.profiles?.full_name || '-') + ' ' + esc(t.driver?.profiles?.phone || ''))}
    ${row('Vehicle', esc(VEHICLES[t.vehicle]) + (t.loading_requested ? ' (loading requested)' : ''))}
    ${row('Pickup', esc(t.pickup_address || '-'))}
    ${row('Drop-off', esc(t.dropoff_address || '-'))}
    ${row('Requested', esc(dt(t.requested_at)))}
    ${row('Accepted', esc(dt(t.accepted_at)))}
    ${row('Arrived', esc(dt(t.arrived_at)))}
    ${row('Started', esc(dt(t.started_at)))}
    ${row('Completed', esc(dt(t.completed_at)))}
    ${row('Cancelled', esc(dt(t.cancelled_at)))}
    ${row('Estimate', t.est_fare != null ? money(t.est_fare) + ' (' + Number(t.est_distance_km || 0).toFixed(1) + ' km)' : '-')}
    ${row('Distance / time', t.distance_km != null ? Number(t.distance_km).toFixed(1) + ' km, ' + Number(t.duration_min || 0).toFixed(0) + ' min' : '-')}
    ${row('Fare', t.fare != null ? money(t.fare) : '-')}
    ${row('Loading charge', money(t.loading_charge))}
    ${row('Total (cash)', t.total_fare != null ? '<b>' + money(t.total_fare) + '</b>' : '-')}
    ${row('Commission', t.status === 'completed' ? money(t.commission_amount) + ' (' + esc(t.commission_plan) + ' plan)' : '-')}
    ${row('Driver rating', t.driver_rating ? esc(t.driver_rating) + ' / 5 ' + esc(t.rating_comment || '') : '-')}
  </dl>`);
  m.onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
}

// ---- Statements ------------------------------------------------------------
async function pageStatements(el) {
  el.innerHTML = `<div class="bar"><h1>Monthly statements</h1>
    <input id="m" type="month">
    <select id="f"><option value="">All</option><option value="unpaid">Unpaid</option><option value="overdue">Overdue</option><option value="paid">Paid</option></select>
    <button id="csv">Export CSV</button></div><div id="list"></div>`;
  const { data, error } = await sb.from('monthly_statements')
    .select('*, drivers(profiles(full_name,phone)), payments(amount)')
    .order('period_start', { ascending: false }).order('issued_at', { ascending: false }).limit(1000);
  if (error) throw error;
  const today = colomboToday();
  const st = s => {
    const paid = sum(s.payments, p => p.amount);
    const overdue = s.status === 'issued' && s.due_date < today;
    return { paid, balance: Number(s.total_due) - paid, overdue };
  };
  const draw = () => {
    const m = $('#m').value, f = $('#f').value;
    const shown = data.filter(s => (!m || s.period_start.startsWith(m)) &&
      (!f || (f === 'paid' ? s.status === 'paid' : f === 'unpaid' ? s.status === 'issued' : st(s).overdue)));
    draw.shown = shown;
    $('#list').innerHTML = table(['Driver', 'Month', 'Plan', '#Trips', '#Cash collected', '#Commission', '#Subscription', '#Total due', '#Balance', 'Due', 'Status', ''],
      shown.map(s => {
        const x = st(s);
        return `<tr><td>${esc(s.drivers?.profiles?.full_name || '-')}</td><td>${esc(s.period_start.slice(0, 7))}</td><td>${esc(s.plan)}</td>
          <td class="n">${s.trips_count}</td><td class="n">${money(s.cash_collected)}</td><td class="n">${money(s.commission_due)}</td>
          <td class="n">${money(s.subscription_fee)}</td><td class="n">${money(s.total_due)}</td><td class="n">${money(x.balance)}</td>
          <td>${esc(dOnly(s.due_date))}</td>
          <td>${s.status === 'paid' ? badge('Paid', 'ok') : x.overdue ? badge('Overdue', 'bad') : badge('Issued', 'warn')}</td>
          <td><button data-id="${esc(s.id)}">${isAdmin() && s.status === 'issued' ? 'Record payment' : 'Details'}</button></td></tr>`;
      }));
  };
  $('#m').onchange = draw;
  $('#f').onchange = draw;
  $('#csv').onclick = () => downloadCSV('goemb-statements.csv', [
    ['Driver', 'Month', 'Plan', 'Trips', 'Cash collected', 'Commission', 'Subscription', 'Total due', 'Paid', 'Balance', 'Due date', 'Status'],
    ...(draw.shown || []).map(s => { const x = st(s); return [s.drivers?.profiles?.full_name, s.period_start.slice(0, 7), s.plan, s.trips_count, Number(s.cash_collected), Number(s.commission_due), Number(s.subscription_fee), Number(s.total_due), x.paid, x.balance, s.due_date, s.status]; })
  ]);
  $('#list').onclick = e => {
    const b = e.target.closest('button[data-id]');
    if (b) statementDetail(b.dataset.id);
  };
  draw();
}

async function statementDetail(id) {
  const { data: s, error } = await sb.from('monthly_statements')
    .select('*, drivers(profiles(full_name,phone)), payments(amount,method,reference,note,recorded_at)').eq('id', id).single();
  if (error) return err(error);
  const paid = sum(s.payments, p => p.amount);
  const balance = Number(s.total_due) - paid;
  const m = openModal(`
    <div class="head"><div><h1>${esc(s.drivers?.profiles?.full_name || 'Driver')}</h1><span class="muted">Statement for ${esc(s.period_start.slice(0, 7))}</span></div><button data-close>Close</button></div>
    <dl>
      <dt>Plan</dt><dd>${esc(s.plan)}</dd>
      <dt>Trips</dt><dd>${s.trips_count}</dd>
      <dt>Cash collected</dt><dd>${money(s.cash_collected)}</dd>
      <dt>Commission</dt><dd>${money(s.commission_due)}</dd>
      <dt>Subscription fee</dt><dd>${money(s.subscription_fee)}</dd>
      <dt>Total due</dt><dd><b>${money(s.total_due)}</b> by ${esc(dOnly(s.due_date))}</dd>
      <dt>Paid so far</dt><dd>${money(paid)}</dd>
      <dt>Balance</dt><dd><b>${money(balance)}</b></dd>
    </dl>
    <h2>Payments</h2>
    ${s.payments.map(p => `<div>${esc(dt(p.recorded_at))}: ${money(p.amount)} &middot; ${esc(p.method)} ${esc(p.reference || '')} <span class="muted">${esc(p.note || '')}</span></div>`).join('') || '<p class="muted">No payments yet</p>'}
    ${isAdmin() && s.status === 'issued' ? `
    <h2>Record a payment</h2>
    <form id="pay" class="form">
      <label>Amount (Rs.) <input name="amount" type="number" step="0.01" min="0.01" max="${balance}" value="${balance.toFixed(2)}" required></label>
      <label>Method <select name="method"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
      <label>Reference (slip or receipt no.) <input name="reference"></label>
      <label>Note <input name="note"></label>
      <button class="primary" type="submit">Save payment</button>
    </form>` : ''}`);
  m.onclick = e => { if (e.target.closest('[data-close]')) closeModal(); };
  const f = $('#pay', m);
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.rpc('record_payment', {
      p_statement: id, p_amount: Number(f.amount.value), p_method: f.method.value,
      p_reference: f.reference.value.trim() || null, p_note: f.note.value.trim() || null
    });
    if (error) return err(error);
    toast('Payment recorded');
    closeModal();
    route();
  };
}

// ---- Driver balances -------------------------------------------------------
async function pageBalances(el) {
  const { data, error } = await sb.from('driver_balances').select('*').order('outstanding', { ascending: false });
  if (error) throw error;
  el.innerHTML = `<div class="bar"><h1>Driver balances</h1><span class="muted">Unbilled commission plus unpaid statements</span></div>` +
    table(['Driver', 'Status', 'Plan', '#Amount owed', 'Can go online'],
      data.map(r => `<tr><td>${esc(r.full_name || '-')}<div class="muted">${esc(r.phone || '')}</div></td><td>${esc(r.status)}</td><td>${esc(r.plan)}</td>
        <td class="n">${money(r.outstanding)}</td><td>${r.blocked ? badge('Blocked', 'bad') : badge('Yes', 'ok')}</td></tr>`));
}

// ---- Reports ---------------------------------------------------------------
async function pageReports(el) {
  el.innerHTML = `<div class="bar"><h1>Reports</h1><input id="m" type="month" value="${colomboToday().slice(0, 7)}"></div><div id="rep"></div>`;
  const run = async () => {
    const ym = $('#m').value;
    if (!ym) return;
    const [a, b] = monthRange(ym);
    $('#rep').innerHTML = '<p class="muted">Loading…</p>';
    try {
      const [trips, stm] = await Promise.all([
        fetchAll(() => sb.from('trips').select('id,status,vehicle,total_fare,commission_amount,driver:drivers(profiles(full_name))')
          .gte('requested_at', a).lt('requested_at', b).order('requested_at').order('id')),
        sb.from('monthly_statements').select('commission_due,subscription_fee,total_due,payments(amount)').eq('period_start', ym + '-01')
      ]);
      if (stm.error) throw stm.error;
      const done = trips.filter(t => t.status === 'completed');
      const count = f => trips.filter(f).length;
      const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;

      const byVeh = Object.keys(VEHICLES).map(v => {
        const r = done.filter(t => t.vehicle === v);
        return `<tr><td>${esc(VEHICLES[v])}</td><td class="n">${r.length}</td><td class="n">${money(sum(r, t => t.total_fare))}</td><td class="n">${money(sum(r, t => t.commission_amount))}</td></tr>`;
      });
      const drv = {};
      done.forEach(t => { const n = t.driver?.profiles?.full_name || 'Unknown'; (drv[n] = drv[n] || []).push(t); });
      const byDrv = Object.entries(drv).sort((x, y) => y[1].length - x[1].length).slice(0, 20)
        .map(([n, r]) => `<tr><td>${esc(n)}</td><td class="n">${r.length}</td><td class="n">${money(sum(r, t => t.total_fare))}</td><td class="n">${money(sum(r, t => t.commission_amount))}</td></tr>`);

      const S = stm.data;
      const billed = sum(S, s => s.total_due), collected = sum(S, s => sum(s.payments, p => p.amount));
      $('#rep').innerHTML = `<div class="cards">
          ${stat(trips.length, 'Trip requests')}
          ${stat(done.length, 'Completed')}
          ${stat(count(t => t.status.startsWith('cancelled')), 'Cancelled')}
          ${stat(count(t => t.status === 'no_drivers'), 'No driver found')}
          ${stat(money(sum(done, t => t.total_fare)), 'Cash fares (all drivers)')}
          ${stat(money(sum(done, t => t.commission_amount)), 'Per-trip commission earned')}
        </div>
        <h2>Statements for ${esc(ym)}</h2>
        ${S.length ? `<div class="cards">
          ${stat(money(billed), 'Billed (commission + subscriptions)')}
          ${stat(money(sum(S, s => s.subscription_fee)), 'Subscription fees')}
          ${stat(money(collected), 'Collected so far')}
          ${stat(money(billed - collected), 'Still owed')}
        </div>` : '<p class="muted">Statements for this month are issued at the start of next month.</p>'}
        <h2>By vehicle type (completed trips)</h2>${table(['Vehicle', '#Trips', '#Cash fares', '#Commission'], byVeh)}
        <h2>Top drivers</h2>${table(['Driver', '#Trips', '#Cash fares', '#Commission'], byDrv)}`;
    } catch (e) { $('#rep').innerHTML = `<p class="err">${esc(e.message || e)}</p>`; }
  };
  $('#m').onchange = run;
  await run();
}

// ---- Fares -----------------------------------------------------------------
async function pageFares(el) {
  const { data, error } = await sb.from('fare_settings').select('*');
  if (error) throw error;
  const order = Object.keys(VEHICLES);
  data.sort((x, y) => order.indexOf(x.vehicle) - order.indexOf(y.vehicle));
  const dis = isAdmin() ? '' : 'disabled';
  const inp = (r, k) => `<input data-k="${k}" type="number" min="0" step="0.01" value="${esc(r[k])}" style="width:7rem" ${dis}>`;
  el.innerHTML = `<div class="bar"><h1>Fares</h1></div>
    <p class="muted">Fare = the larger of the minimum fare and (base + per km x distance + per minute x time). Small lorry adds the loading charge when the customer asks for loading help. A vehicle type is offered to customers only while Active is ticked.</p>
    <div class="tw"><table><thead><tr><th>Vehicle</th><th>Base fare</th><th>Per km</th><th>Per minute</th><th>Minimum fare</th><th>Loading charge</th><th>Active</th><th></th></tr></thead><tbody>
    ${data.map(r => `<tr data-v="${esc(r.vehicle)}"><td><b>${esc(VEHICLES[r.vehicle])}</b></td>
      <td>${inp(r, 'base_fare')}</td><td>${inp(r, 'per_km')}</td><td>${inp(r, 'per_min')}</td><td>${inp(r, 'min_fare')}</td>
      <td>${r.vehicle === 'small_lorry' ? inp(r, 'loading_charge') : '<span class="muted">-</span>'}</td>
      <td><input data-k="active" type="checkbox" ${r.active ? 'checked' : ''} ${dis}></td>
      <td>${isAdmin() ? '<button class="primary" data-save>Save</button>' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  el.onclick = async e => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const tr = b.closest('tr'), patch = {};
    tr.querySelectorAll('[data-k]').forEach(i => { patch[i.dataset.k] = i.type === 'checkbox' ? i.checked : Number(i.value || 0); });
    if (patch.active && patch.base_fare <= 0 && patch.per_km <= 0) return toast('Set a base fare or per-km rate before turning this vehicle on', true);
    const { error } = await sb.from('fare_settings').update(patch).eq('vehicle', tr.dataset.v);
    if (error) return err(error);
    toast('Saved');
  };
}

// ---- Billing settings ------------------------------------------------------
async function pageSettings(el) {
  const { data, error } = await sb.from('billing_settings').select('*').single();
  if (error) throw error;
  const F = [
    ['commission_percent', 'Commission per trip (%)', 'Percentage plan: taken from each trip fare. Required before trips can complete.', '0.01', true],
    ['subscription_fee', 'Monthly subscription fee (Rs.)', 'Subscription plan: flat fee billed at month end. Required if any driver uses it.', '0.01', true],
    ['credit_limit', 'Credit limit (Rs.)', 'A driver is blocked when the unpaid amount goes above this. Leave empty for no limit.', '0.01', true],
    ['payment_days', 'Payment days', 'Days a driver has to pay after a statement is issued.', '1', false],
    ['grace_days', 'Grace days', 'Extra days after the due date before the driver is blocked.', '1', false],
    ['search_radius_m', 'Search radius (metres)', 'How far from the pickup to look for drivers.', '100', false],
    ['offer_timeout_s', 'Request timeout (seconds)', 'Time drivers have to accept before the request shows "no drivers".', '5', false],
    ['max_offers', 'Drivers per request', 'How many nearest drivers receive each request.', '1', false]
  ];
  el.innerHTML = `<div class="bar"><h1>Billing settings</h1></div>
    <form id="s" class="form card">
      ${F.map(([k, label, hint, step]) => `<label>${label}<input name="${k}" type="number" step="${step}" min="0" value="${esc(data[k] ?? '')}" ${isAdmin() ? '' : 'disabled'}><span class="hint">${hint}</span></label>`).join('')}
      ${isAdmin() ? '<button class="primary" type="submit">Save settings</button>' : ''}
    </form>`;
  $('#s').onsubmit = async e => {
    e.preventDefault();
    const patch = {};
    F.forEach(([k, , , , nullable]) => {
      const v = e.target[k].value.trim();
      patch[k] = v === '' ? (nullable ? null : data[k]) : Number(v);
    });
    const { error } = await sb.from('billing_settings').update(patch).eq('id', true);
    if (error) return err(error);
    toast('Settings saved');
  };
}

// ---------------------------------------------------------------------------
// Router and sign in
// ---------------------------------------------------------------------------
async function route() {
  if (state.cleanup) { state.cleanup(); state.cleanup = null; }
  const id = (location.hash || '#dashboard').slice(1);
  const page = PAGES.find(p => p[0] === id) || PAGES[0];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.id === page[0]));
  const v = $('#view');
  v.onclick = null;
  v.innerHTML = '<p class="muted">Loading…</p>';
  try { await page[2](v); }
  catch (e) { v.innerHTML = `<p class="err">${esc(e.message || e)}</p>`; }
}
window.addEventListener('hashchange', route);

function showLogin(msg) {
  window.__bootDone = true;
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginErr').textContent = msg || '';
}

function showApp() {
  window.__bootDone = true;
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#nav').innerHTML = `<div class="brand"><img class="logo-full" src="logo.jpg" alt="GoEmb"><img class="logo-icon" src="icon.png" alt="GoEmb"></div>` +
    PAGES.map(p => `<a href="#${p[0]}" data-id="${p[0]}">${p[1]}</a>`).join('') +
    `<div class="who">${esc(state.profile.full_name || state.profile.role)}<button id="signout" class="link">Sign out</button></div>`;
  $('#signout').onclick = async () => { await sb.auth.signOut(); location.hash = ''; location.reload(); };
  route();
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  // The panel only hides screens; the database rules (RLS) are what actually protect the data.
  if (error || !p || !['admin', 'staff'].includes(p.role)) {
    await sb.auth.signOut();
    return showLogin('This account does not have admin access.');
  }
  state.profile = p;
  showApp();
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  $('#loginErr').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  if (error) { $('#loginErr').textContent = error.message; return; }
  f.reset();
  boot();
};

if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR-PROJECT')) {
  showLogin('Open config.js and add your Supabase URL and anon key.');
} else {
  boot().catch(e => showLogin('Could not start: ' + ((e && e.message) || e)));
}
