/**
 * Apache Rental Group — Mobile Web View + Editor
 * ==============================================
 * Serves a phone-friendly app that READS every job from the calendar and lets
 * the team SCAN email on demand and ADD / EDIT / REMOVE jobs by hand.
 *
 *   doGet()                 -> serves the UI (src/Index.html)
 *   getJobs()               -> all jobs parsed from calendar events
 *   getReview()             -> emails the AI couldn't place (Orders/Review label)
 *   scanNow()               -> run the AI pass over the inbox right now
 *   createJob/updateJob/deleteJob(data, pin) -> manual editing (PIN-gated)
 *
 * Manual jobs/customizations are stored inside each event's description as
 * "Key: value" lines (Priority / Tags / Color / Ref), so the data lives with
 * the calendar — no extra database. Reuses helpers from Code.gs (getCalendar,
 * buildTitle, updateEvent, combineDateTime, parseLocalDate, fmtDateTime, etc.).
 */

// hex shown in the UI  ->  nearest Google Calendar event color
var WEB_PALETTE = [
  { hex: '#2563eb', gcal: 'BLUE' },
  { hex: '#16a34a', gcal: 'GREEN' },
  { hex: '#dc2626', gcal: 'RED' },
  { hex: '#ea580c', gcal: 'ORANGE' },
  { hex: '#9333ea', gcal: 'MAUVE' },
  { hex: '#ca8a04', gcal: 'YELLOW' },
  { hex: '#0891b2', gcal: 'CYAN' },
  { hex: '#db2777', gcal: 'PALE_RED' },
  { hex: '#0d9488', gcal: 'PALE_GREEN' },
  { hex: '#475569', gcal: 'GRAY' }
];


/** Serve the mobile web UI. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('src/Index')
    .setTitle('Apache Rental — Jobs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ===================== READ =====================

/** Every job parsed from the calendar (drop-off + pick-up collapsed into one). */
function getJobs() {
  var cal = getCalendar();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60);
  var end   = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate()); // ~2 years ahead

  var events = cal.getEvents(start, end);
  var map = {};

  events.forEach(function (ev) {
    var title = ev.getTitle() || '';
    var role = title.indexOf('📦') === 0 ? 'dropoff'
             : title.indexOf('📥') === 0 ? 'pickup' : null;
    if (!role) return;

    var f = parseEventDescription(ev.getDescription() || '');
    var drop = splitDateTime(f['Drop-off']);
    var pick = splitDateTime(f['Pick-up']);
    var job = clean(f['Show']) || stripTitle(title);
    var venue = clean(f['Venue']);
    var ref = f['Ref'] || '';

    var key = ref ? ('ref:' + ref)
                  : [job, venue, drop.date, drop.time, pick.date, pick.time].join('|');

    var j = map[key];
    if (!j) {
      var tags = clean(f['Tags']);
      j = {
        ref: ref,
        job: job,
        venue: venue,
        dropOffDate: drop.date, dropOffTime: drop.time,
        pickUpDate: pick.date,  pickUpTime: pick.time,
        showDates: clean(f['Show dates']),
        notes: clean(f['Notes']),
        priority: clean(f['Priority']) || 'Normal',
        color: clean(f['Color']),
        tags: tags ? tags.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        dropOffEventId: null,
        pickUpEventId: null,
        manual: ref.indexOf('m-') === 0
      };
      map[key] = j;
    }
    if (role === 'dropoff') j.dropOffEventId = ev.getId();
    else j.pickUpEventId = ev.getId();
  });

  var jobs = Object.keys(map).map(function (k) { return map[k]; });
  return { jobs: jobs, generatedAt: new Date().toISOString() };
}

/** Emails the AI flagged but couldn't place — the Orders/Review label. */
function getReview() {
  var label = GmailApp.getUserLabelByName(CONFIG.REVIEW_LABEL);
  if (!label) return { items: [] };
  var threads = label.getThreads(0, 50);
  var items = threads.map(function (t) {
    var m = t.getMessages()[0];
    return {
      subject: t.getFirstMessageSubject() || '(no subject)',
      from: m ? m.getFrom() : '',
      date: t.getLastMessageDate().toISOString(),
      snippet: (m ? m.getPlainBody() : '').replace(/\s+/g, ' ').slice(0, 220)
    };
  });
  return { items: items };
}


// ===================== SCAN =====================

/**
 * Run the AI pass over the inbox right now, then return refreshed jobs + a
 * human summary. A script lock stops two scans from overlapping.
 */
function scanNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    var busy = getJobs();
    busy.message = 'A scan is already running — give it a few seconds, then refresh.';
    busy.scanned = false;
    return busy;
  }
  try {
    var summary = processOrderEmails();
    var res = getJobs();
    res.scan = summary;
    res.scanned = true;
    res.message = scanMessage(summary);
    return res;
  } catch (err) {
    var out = getJobs();
    out.message = 'Scan error: ' + (err && err.message ? err.message : err);
    out.scanned = false;
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** Turn a scan summary into a short, friendly status line for the UI. */
function scanMessage(s) {
  if (!s) return 'Scan complete.';
  if (!s.synced && !s.review && !s.errors) return 'No new jobs found.';
  var parts = [];
  if (s.synced) parts.push(s.synced + ' job' + (s.synced === 1 ? '' : 's') + ' added/updated');
  if (s.review) parts.push(s.review + ' need' + (s.review === 1 ? 's' : '') + ' review');
  if (s.errors) parts.push(s.errors + ' error' + (s.errors === 1 ? '' : 's'));
  return parts.join(' · ');
}


// ===================== WRITE (manual add / edit / remove) =====================

function createJob(data, pin) {
  requirePin(pin);
  var cal = getCalendar();
  var ref = 'm-' + Utilities.getUuid();
  writeJobEvents(cal, data, ref, {});
  return afterMutation('Added: ' + (data.job || 'Untitled job'));
}

function updateJob(data, pin) {
  requirePin(pin);
  var cal = getCalendar();
  var ref = data.ref || ('m-' + Utilities.getUuid());
  writeJobEvents(cal, data, ref, { dropoff: data.dropOffEventId, pickup: data.pickUpEventId });
  return afterMutation('Updated: ' + (data.job || 'Untitled job'));
}

function deleteJob(data, pin) {
  requirePin(pin);
  var cal = getCalendar();
  [data.dropOffEventId, data.pickUpEventId].forEach(function (id) {
    if (id) { var ev = safeGetEvent(cal, id); if (ev) ev.deleteEvent(); }
  });
  return afterMutation('Removed: ' + (data.job || 'job'));
}

/** Refreshed jobs + a status message, returned after any manual change. */
function afterMutation(msg) {
  var res = getJobs();
  res.message = msg;
  res.scanned = false;
  return res;
}

/** Create or update the drop-off and pick-up events for one manual job. */
function writeJobEvents(cal, d, ref, existing) {
  var desc = buildManualDescription(d, ref);
  var color = gcalColorFromHex(d.color, d.job);
  return {
    dropoff: writeRole(cal, 'dropoff', d.dropOffDate, d.dropOffTime, d, desc, color, existing && existing.dropoff),
    pickup:  writeRole(cal, 'pickup',  d.pickUpDate,  d.pickUpTime,  d, desc, color, existing && existing.pickup)
  };
}

function writeRole(cal, role, dateStr, timeStr, d, desc, color, existingId) {
  var title = buildTitle(role, { job_name: d.job, venue: d.venue });
  if (!dateStr) {
    if (existingId) { var e = safeGetEvent(cal, existingId); if (e) e.deleteEvent(); }
    return null;
  }
  if (existingId) {
    var ev = safeGetEvent(cal, existingId);
    if (ev) { updateEvent(ev, title, dateStr, timeStr, desc, color); return existingId; }
  }
  var created = createEventSimple(cal, title, dateStr, timeStr, desc, color);
  return created ? created.getId() : null;
}

/** Like Code.gs createEvent but WITHOUT same-day adopt — manual jobs are exact. */
function createEventSimple(cal, title, dateStr, timeStr, desc, color) {
  var ev;
  if (timeStr) {
    var s = combineDateTime(dateStr, timeStr);
    ev = cal.createEvent(title, s, new Date(s.getTime() + 3600000), { description: desc });
  } else {
    ev = cal.createAllDayEvent(title, parseLocalDate(dateStr), { description: desc });
  }
  if (color) ev.setColor(color);
  return ev;
}

function buildManualDescription(d, ref) {
  return [
    'Show: '       + (d.job || 'TBD'),
    'Venue: '      + (d.venue || 'TBD'),
    'Drop-off: '   + fmtDateTime(d.dropOffDate, d.dropOffTime),
    'Pick-up: '    + fmtDateTime(d.pickUpDate, d.pickUpTime),
    'Show dates: ' + (d.showDates || 'TBD'),
    'Notes: '      + (d.notes || 'TBD'),
    'Priority: '   + (d.priority || 'Normal'),
    'Tags: '       + ((d.tags && d.tags.length) ? d.tags.join(', ') : ''),
    'Color: '      + (d.color || ''),
    'Ref: '        + ref
  ].join('\n');
}

/** Map a UI hex to the nearest Google Calendar event color (fallback: job hash). */
function gcalColorFromHex(hex, jobName) {
  for (var i = 0; i < WEB_PALETTE.length; i++) {
    if (WEB_PALETTE[i].hex === hex) return CalendarApp.EventColor[WEB_PALETTE[i].gcal];
  }
  return colorForJob(jobName);
}

/** Block edits unless the caller supplied the configured edit code. */
function requirePin(pin) {
  var need = (CONFIG.EDIT_PIN || '').trim();
  if (need && String(pin == null ? '' : pin).trim() !== need) {
    throw new Error('Wrong edit code (PIN). Ask your admin for the code.');
  }
}


// ===================== PARSING HELPERS =====================

/** Parse 'Key: value' lines from an event description into a map. */
function parseEventDescription(desc) {
  var out = {};
  desc.split('\n').forEach(function (line) {
    var i = line.indexOf(':');
    if (i > 0) {
      var k = line.slice(0, i).trim();
      if (k && !(k in out)) out[k] = line.slice(i + 1).trim();
    }
  });
  return out;
}

/** 'YYYY-MM-DD HH:MM' | 'YYYY-MM-DD' | 'TBD' -> { date, time }. */
function splitDateTime(val) {
  if (!val || val === 'TBD') return { date: null, time: null };
  var parts = val.split(/\s+/);
  var date = /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] : null;
  var time = (parts[1] && /^\d{1,2}:\d{2}$/.test(parts[1])) ? parts[1] : null;
  return { date: date, time: time };
}

/** Drop empty / TBD values down to ''. */
function clean(v) {
  return (!v || v === 'TBD') ? '' : v;
}

/** Fallback when an event has no structured description. */
function stripTitle(title) {
  var m = title.replace(/^📦\s*DROP OFF\s*[—-]\s*/, '')
               .replace(/^📥\s*PICK UP\s*[—-]\s*/, '');
  var at = m.lastIndexOf(' @ ');
  return at > 0 ? m.slice(0, at).trim() : m.trim();
}
