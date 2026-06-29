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
 *   createJob/updateJob/deleteJob(data, pin) -> manual editing (open by default;
 *                                               set CONFIG.EDIT_PIN to require a code)
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


/**
 * Entry point. With ?action=... it behaves as a JSON API (for the clean-URL
 * front-end hosted off Google). With no action it serves the HTML app (so the
 * old script.google.com URL keeps working too).
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ics') return serveIcs(p);          // subscription feed (any calendar app)
  if (p.action) return handleApi(e);
  return HtmlService.createHtmlOutputFromFile('src/Index')
    .setTitle('Apache Rental — Jobs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) { return handleApi(e); }

/** JSON API dispatcher. data = JSON in the `data` param; pin in the `pin` param. */
function handleApi(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    var data = p.data ? JSON.parse(p.data) : null;
    var pin = p.pin || '';
    switch (p.action) {
      case 'getJobs':           out = getJobs(); break;
      case 'getReview':         out = getReview(); break;
      case 'getCrew':           out = getCrew(); break;
      case 'getFeedInfo':       out = getFeedInfo(); break;
      case 'scanNow':           out = scanNow(); break;
      case 'createJob':         out = createJob(data, pin); break;
      case 'updateJob':         out = updateJob(data, pin); break;
      case 'deleteJob':         out = deleteJob(data, pin); break;
      case 'dismissReview':     out = dismissReview(data, pin); break;
      case 'removeReviewEmail': out = removeReviewEmail(data, pin); break;
      case 'addReviewToJob':    out = addReviewToJob(data, pin); break;
      case 'addCrew':           out = addCrew(data, pin); break;
      case 'removeCrew':        out = removeCrew(data, pin); break;
      default:                  out = { __error: 'Unknown action: ' + p.action };
    }
  } catch (err) {
    out = { __error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
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
        dropLocation: clean(f['Drop-off location']),
        pickLocation: clean(f['Pick-up location']),
        showDates: clean(f['Show dates']),
        notes: decodeNotes(clean(f['Notes'])),
        priority: clean(f['Priority']) || 'Normal',
        color: clean(f['Color']),
        tags: tags ? tags.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        emailUrl: clean(f['Source email']),
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
      id: t.getId(),
      date: t.getLastMessageDate().toISOString(),
      snippet: (m ? m.getPlainBody() : '').replace(/\s+/g, ' ').slice(0, 220),
      permalink: t.getPermalink()   // direct Gmail link — no AI, just metadata
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
    res.review = getReview().items;
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
  if (data.reviewThreadId) unflagThread(data.reviewThreadId); // created from a review item
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

// ---- Needs Review actions ----

/** "Dismiss" — clear the review flag; the email stays in Gmail. */
function dismissReview(payload, pin) {
  requirePin(pin);
  unflagThread(payload && payload.threadId);
  return afterMutation('Dismissed from review.');
}

/** "Remove" — move the email thread to Trash (recoverable for 30 days). */
function removeReviewEmail(payload, pin) {
  requirePin(pin);
  var t = (payload && payload.threadId) ? GmailApp.getThreadById(payload.threadId) : null;
  if (t) t.moveToTrash();
  return afterMutation('Email moved to Trash.');
}

/** "Add to job" — append this email to an existing job's notes, then dismiss it. */
function addReviewToJob(payload, pin) {
  requirePin(pin);
  var cal = getCalendar();
  var d = payload.job || {};
  if (payload.note) d.notes = (d.notes ? d.notes + '\n\n' : '') + payload.note;
  var ref = d.ref || ('m-' + Utilities.getUuid());
  writeJobEvents(cal, d, ref, { dropoff: d.dropOffEventId, pickup: d.pickUpEventId });
  if (payload.threadId) unflagThread(payload.threadId);
  return afterMutation('Added to “' + (d.job || 'job') + '”.');
}

/** Clear the Review label on a thread + remember it so a scan won't re-flag it. */
function unflagThread(id) {
  if (!id) return;
  var t = GmailApp.getThreadById(id);
  if (!t) return;
  var label = GmailApp.getUserLabelByName(CONFIG.REVIEW_LABEL);
  if (label) t.removeLabel(label);
  saveState(id, { msgCount: t.getMessageCount(), review: false, dismissed: true, events: {} });
}

/** Refreshed jobs + review + a status message, returned after any change. */
function afterMutation(msg) {
  var res = getJobs();
  res.review = getReview().items;
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
  var lines = [
    'Show: '       + (d.job || 'TBD'),
    'Venue: '      + (d.venue || 'TBD'),
    'Drop-off: '   + fmtDateTime(d.dropOffDate, d.dropOffTime),
    'Drop-off location: ' + (d.dropLocation || 'TBD'),
    'Pick-up: '    + fmtDateTime(d.pickUpDate, d.pickUpTime),
    'Pick-up location: '  + (d.pickLocation || 'TBD'),
    'Show dates: ' + (d.showDates || 'TBD'),
    'Notes: '      + (d.notes ? encodeNotes(d.notes) : 'TBD'),
    'Priority: '   + (d.priority || 'Normal'),
    'Tags: '       + ((d.tags && d.tags.length) ? d.tags.join(', ') : ''),
    'Color: '      + (d.color || ''),
    'Ref: '        + ref
  ];
  // Preserve the link back to the source email (e.g. on AI jobs edited by hand).
  if (d.emailUrl) lines.push('', 'Source email: ' + d.emailUrl);
  return lines.join('\n');
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


// ============== CREW (share the calendar to people's own devices) ==============

/** Which calendar to share (matches the one events are written to). */
function calId() {
  return CONFIG.CALENDAR_ID === 'primary' ? 'primary' : CONFIG.CALENDAR_ID;
}

/** People the Apache calendar is shared with (so it syncs to their own Google Calendar). */
function getCrew() {
  try {
    var acl = Calendar.Acl.list(calId());
    var items = (acl.items || []).filter(function (r) {
      return r.scope && r.scope.type === 'user' && r.role !== 'owner';
    }).map(function (r) {
      return { email: r.scope.value, role: r.role, ruleId: r.id };
    });
    return { crew: items };
  } catch (err) {
    return { crew: [], crewError: 'Sharing isn’t available yet: ' + (err && err.message ? err.message : err) };
  }
}

/** Share the calendar with someone so it shows up on their own Google Calendar. */
function addCrew(payload, pin) {
  requirePin(pin);
  var email = (payload.email || '').trim().toLowerCase();
  if (email.indexOf('@') < 1 || email.indexOf('.') < 0) throw new Error('Enter a valid email address.');
  Calendar.Acl.insert(
    { role: 'reader', scope: { type: 'user', value: email } },
    calId(),
    { sendNotifications: true }
  );
  var res = getCrew();
  res.message = 'Shared with ' + email + ' — they’ll get an email to add the calendar.';
  return res;
}

/** Stop sharing the calendar with someone. */
function removeCrew(payload, pin) {
  requirePin(pin);
  if (payload.ruleId) Calendar.Acl.remove(calId(), payload.ruleId);
  var res = getCrew();
  res.message = 'Removed ' + (payload.email || 'person') + '.';
  return res;
}


// ============== ICS SUBSCRIPTION FEED (works on ANY provider) ==============
// Apple Calendar (iCloud), Outlook/Hotmail, Yahoo, Proton, Google — anything
// that can "subscribe to a calendar URL" — can follow this feed and get the
// jobs, refreshing on its own. No Google account needed. It's view-only: a
// foreign provider can't be made to accept our edits, only mirror them.

/**
 * One unguessable token so the feed URL isn't trivially discoverable. Created
 * once and reused; never rotated automatically (rotating would break anyone
 * already subscribed). To rotate by hand, delete FEED_TOKEN in Script Properties.
 */
function feedToken() {
  var sp = PropertiesService.getScriptProperties();
  var t = sp.getProperty('FEED_TOKEN');
  if (!t) { t = Utilities.getUuid().replace(/-/g, '').slice(0, 20); sp.setProperty('FEED_TOKEN', t); }
  return t;
}

/** The subscribe links the UI hands out (https for copy/paste, webcal:// for one-tap). */
function getFeedInfo() {
  var base = ScriptApp.getService().getUrl();         // .../exec
  var url = base + '?action=ics&token=' + feedToken();
  return { icsUrl: url, webcalUrl: url.replace(/^https?:\/\//, 'webcal://') };
}

/** Serve the live .ics feed (text/calendar). Requires the matching token. */
function serveIcs(p) {
  if ((p.token || '') !== feedToken()) {
    return ContentService.createTextOutput('Invalid or missing feed token.')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService.createTextOutput(buildIcsFeed())
    .setMimeType(ContentService.MimeType.ICAL);
}

/** Build an iCalendar document mirroring the job events (same window as getJobs). */
function buildIcsFeed() {
  var cal = getCalendar();
  var tz = getTz();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60);
  var end   = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());
  var stampNow = icsUtc(now);

  var out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apache Rental Group//Jobs//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Apache Jobs',
    'X-WR-CALDESC:Drop-off & pick-up jobs from Apache Rental Group',
    'X-WR-TIMEZONE:' + tz,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',   // hint subscribers to refresh hourly
    'X-PUBLISHED-TTL:PT1H'
  ];

  cal.getEvents(start, end).forEach(function (ev) {
    var title = ev.getTitle() || '';
    if (title.indexOf('📦') !== 0 && title.indexOf('📥') !== 0) return;  // jobs only

    out.push('BEGIN:VEVENT');
    out.push('UID:' + icsEscape(ev.getId()));
    out.push('DTSTAMP:' + stampNow);
    out.push('LAST-MODIFIED:' + icsUtc(ev.getLastUpdated() || now));
    if (ev.isAllDayEvent()) {
      // floating dates — getAllDayEndDate() is already the exclusive end iCal wants
      out.push('DTSTART;VALUE=DATE:' + icsDate(ev.getAllDayStartDate(), tz));
      out.push('DTEND;VALUE=DATE:'   + icsDate(ev.getAllDayEndDate(),   tz));
    } else {
      // UTC instants (trailing Z) render at the right local time everywhere — no VTIMEZONE needed
      out.push('DTSTART:' + icsUtc(ev.getStartTime()));
      out.push('DTEND:'   + icsUtc(ev.getEndTime()));
    }
    out.push('SUMMARY:' + icsEscape(title));
    var desc = ev.getDescription() || '';
    if (desc) out.push('DESCRIPTION:' + icsEscape(desc));
    var loc = ev.getLocation() || '';
    if (loc) out.push('LOCATION:' + icsEscape(loc));
    out.push('END:VEVENT');
  });

  out.push('END:VCALENDAR');
  return foldIcs(out).join('\r\n') + '\r\n';
}

function icsUtc(d)      { return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"); }
function icsDate(d, tz) { return Utilities.formatDate(d, tz, 'yyyyMMdd'); }

/** Escape text for an iCal value (RFC 5545): backslash, semicolon, comma, newlines. */
function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold lines at 73 chars per RFC 5545, without splitting a surrogate pair (emoji). */
function foldIcs(lines) {
  var out = [];
  lines.forEach(function (line) {
    while (line.length > 73) {
      var cut = 73;
      var c = line.charCodeAt(cut - 1);
      if (c >= 0xD800 && c <= 0xDBFF) cut--;   // don't cut between an emoji's two halves
      out.push(line.slice(0, cut));
      line = ' ' + line.slice(cut);
    }
    out.push(line);
  });
  return out;
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
