/**
 * Apache Rental Group — Email -> Google Calendar AI Automation
 * ============================================================
 * Runs on Google's servers (no IDE or laptop needed). Twice a day it scans
 * the shared Orders inbox, reads each NEW or CHANGED email thread, asks Claude
 * to pull the show name / venue / drop-off / pick-up / notes, and writes neat,
 * color-coded events onto the shared calendar. If a thread changes later, it
 * UPDATES the same events instead of duplicating. Missing details show as TBD.
 *
 * Key behaviors:
 *   - Per-thread state (PropertiesService) tracks message count + event IDs.
 *   - Unchanged threads cost nothing (no AI call) — only new/changed reparse.
 *   - Cross-thread duplicates of the same job collapse onto one event.
 *   - Each job gets a consistent color; drop-off + pick-up share it.
 *   - Can't place a date? -> flagged Orders/Review until the info arrives.
 *
 * See README.md for the one-time human setup (email, calendar, API key, deploy).
 */

// ===================== CONFIG — edit these =====================
const CONFIG = {
  SOURCE_LABEL: 'Orders',          // Gmail label the script processes
  REVIEW_LABEL: 'Orders/Review',   // flagged when dates can't be determined yet
  CALENDAR_ID:  'primary',         // 'primary', or paste the shared calendar's ID
  MODEL:        'claude-sonnet-4-6', // 'claude-haiku-4-5-20251001' = cheaper/faster
  RUN_HOURS:    [7, 22],           // trigger hours (24h, project timezone): 7 AM & 10 PM
  MAX_THREADS_PER_RUN: 100,        // covers recent/active threads
  MAX_THREAD_CHARS: 18000,         // trim very long threads to control cost
  EDIT_PIN:     'apache'           // code required in the web app to add/edit/delete jobs ('' = no code)
};
// ==============================================================


/** RUN ONCE: creates labels + installs the daily triggers. Approve the OAuth prompt. */
function setup() {
  [CONFIG.SOURCE_LABEL, CONFIG.REVIEW_LABEL].forEach(function (n) {
    if (!GmailApp.getUserLabelByName(n)) GmailApp.createLabel(n);
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processOrderEmails') ScriptApp.deleteTrigger(t);
  });
  CONFIG.RUN_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('processOrderEmails').timeBased().atHour(h).everyDays(1).create();
  });
  Logger.log('Setup complete. Triggers at hour(s): ' + CONFIG.RUN_HOURS.join(', '));
  Logger.log('REMINDERS: set ANTHROPIC_API_KEY in Script Properties; set CALENDAR_ID if not primary;');
  Logger.log('confirm the project timezone (Project Settings) is America/Los_Angeles.');
}


/**
 * Main loop — what the triggers and the "Scan emails" button call.
 * Reads the inbox directly (plus anything labeled Orders), so order emails
 * are processed without needing to be labeled by hand. Returns a summary.
 */
function processOrderEmails() {
  var review = GmailApp.getUserLabelByName(CONFIG.REVIEW_LABEL);
  if (!review) { Logger.log('Run setup() first.'); return { synced: 0, review: 0, errors: 0, scanned: 0 }; }
  var source = GmailApp.getUserLabelByName(CONFIG.SOURCE_LABEL);
  var cal = getCalendar();

  var threads = collectThreads(source);
  var summary = { synced: 0, review: 0, errors: 0, scanned: threads.length };

  threads.forEach(function (thread) {
    var id = thread.getId();
    var msgCount = thread.getMessageCount();
    var state = getState(id);

    // Seen before with no new messages -> nothing changed, skip (no AI cost).
    if (state && state.msgCount === msgCount) return;

    try {
      var order = callClaude(getThreadText(thread));
      var placeable = order.is_order &&
                      order.confidence !== 'low' &&
                      (order.drop_off_date || order.pickup_date);

      if (!placeable) {
        thread.addLabel(review);
        // remember count so we don't reparse until a NEW reply arrives
        saveState(id, { msgCount: msgCount, review: true, events: (state && state.events) || {} });
        summary.review++;
        return;
      }

      thread.removeLabel(review); // clear any prior flag now that we have dates
      var events = syncEvents(cal, order, thread, (state && state.events) || {});
      saveState(id, { msgCount: msgCount, review: false, events: events, jobName: order.job_name });
      summary.synced++;
      Logger.log('Synced: ' + order.job_name);

    } catch (err) {
      Logger.log('Error (will retry next run): ' + err + ' | ' + thread.getFirstMessageSubject());
      thread.addLabel(review);
      summary.errors++;
      // do NOT save msgCount on error, so transient failures retry next run
    }
  });

  Logger.log('Scan summary: ' + JSON.stringify(summary));
  return summary;
}

/** Candidate threads = current inbox + anything already labeled Orders (deduped). */
function collectThreads(source) {
  var seen = {}, out = [];
  function add(t) { var id = t.getId(); if (!seen[id]) { seen[id] = true; out.push(t); } }
  GmailApp.getInboxThreads(0, CONFIG.MAX_THREADS_PER_RUN).forEach(add);
  if (source) source.getThreads(0, CONFIG.MAX_THREADS_PER_RUN).forEach(add);
  return out;
}


/** Flatten the whole thread into one text block for the model. */
function getThreadText(thread) {
  var text = thread.getMessages().map(function (m) {
    return 'From: ' + m.getFrom() +
           '\nDate: ' + m.getDate() +
           '\nSubject: ' + m.getSubject() +
           '\n\n' + m.getPlainBody();
  }).join('\n\n----- next message -----\n\n');
  if (text.length > CONFIG.MAX_THREAD_CHARS) {
    text = text.slice(0, CONFIG.MAX_THREAD_CHARS) + '\n\n[thread truncated]';
  }
  return text;
}


/** Ask Claude to extract the current order state from the full thread. */
function callClaude(threadText) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in Script Properties');

  var today = Utilities.formatDate(new Date(), getTz(), "yyyy-MM-dd (EEEE)");

  var system =
    'You are an order-parsing assistant for Apache Rental Group, a broadcast equipment ' +
    'rental company (cameras, fiber, cable, monitors, broadcast gear). You read a client ' +
    'email thread and extract the CURRENT state of one rental order. The thread may contain ' +
    'later changes — always reflect the most up-to-date dates, times, and venue from the ' +
    'latest messages. Resolve relative dates against today. Return ONLY valid minified JSON ' +
    'matching the schema — no markdown, no commentary.';

  var user =
    "Today's date is " + today + ".\n\nEMAIL THREAD:\n" + threadText + "\n\n" +
    'Return JSON with exactly these keys:\n' +
    '{"is_order":boolean,"confidence":"high|medium|low","job_name":string,' +
    '"venue":string|null,"drop_off_date":"YYYY-MM-DD"|null,"drop_off_time":"HH:MM"|null,' +
    '"pickup_date":"YYYY-MM-DD"|null,"pickup_time":"HH:MM"|null,"show_dates":string|null,' +
    '"notes":string|null}\n\n' +
    'Rules:\n' +
    '- is_order is true ONLY if this is a genuine equipment rental order/show with at least ' +
    'one identifiable drop-off or pickup date.\n' +
    '- Use 24-hour times. If a value is not stated, return null (do NOT write "TBD" — the ' +
    'system fills that in).\n' +
    '- confidence is "low" if dates are ambiguous or you are guessing. Be conservative — a ' +
    'wrong date is worse than flagging for review.\n' +
    '- notes: capture delivery/dock/loading instructions, on-site contact, and special requests.';

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CONFIG.MODEL, max_tokens: 1024, system: system,
      messages: [{ role: 'user', content: user }]
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Anthropic API ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  var data = JSON.parse(res.getContentText());
  var out = data.content.filter(function (b) { return b.type === 'text'; })
                        .map(function (b) { return b.text; }).join('').trim();
  return JSON.parse(out.replace(/```json|```/g, '').trim());
}


/** Create or update the drop-off and pick-up events for one order. */
function syncEvents(cal, order, thread, events) {
  events.dropoff = syncRole(cal, 'dropoff', order.drop_off_date, order.drop_off_time, order, thread, events.dropoff);
  events.pickup  = syncRole(cal, 'pickup',  order.pickup_date,  order.pickup_time,  order, thread, events.pickup);
  return events;
}

function syncRole(cal, role, dateStr, timeStr, order, thread, existingId) {
  // No date for this role -> remove a stale event if one existed.
  if (!dateStr) {
    if (existingId) { var stale = safeGetEvent(cal, existingId); if (stale) stale.deleteEvent(); }
    return null;
  }
  var title = buildTitle(role, order);
  var desc  = buildDescription(order, thread);
  var color = colorForJob(order.job_name);

  // Update the existing event if we still have it.
  if (existingId) {
    var ev = safeGetEvent(cal, existingId);
    if (ev) { updateEvent(ev, title, dateStr, timeStr, desc, color); return existingId; }
  }
  // Otherwise create (adopting any same-day duplicate that already exists).
  var created = createEvent(cal, title, dateStr, timeStr, desc, color);
  return created ? created.getId() : null;
}

function createEvent(cal, title, dateStr, timeStr, desc, color) {
  var day = parseLocalDate(dateStr);
  // Cross-thread dedup: if the same job already sits on this day, adopt it.
  var sameDay = cal.getEventsForDay(day);
  for (var i = 0; i < sameDay.length; i++) {
    if (normalizeTitle(sameDay[i].getTitle()) === normalizeTitle(title)) {
      Logger.log('Duplicate adopted (not recreated): ' + title);
      return sameDay[i];
    }
  }
  var ev;
  if (timeStr) {
    var s = combineDateTime(dateStr, timeStr);
    ev = cal.createEvent(title, s, new Date(s.getTime() + 3600000), { description: desc });
  } else {
    ev = cal.createAllDayEvent(title, day, { description: desc });
  }
  if (color) ev.setColor(color);
  return ev;
}

function updateEvent(ev, title, dateStr, timeStr, desc, color) {
  ev.setTitle(title);
  ev.setDescription(desc);
  if (color) ev.setColor(color);
  if (timeStr) {
    var s = combineDateTime(dateStr, timeStr);
    ev.setTime(s, new Date(s.getTime() + 3600000));
  } else {
    ev.setAllDayDate(parseLocalDate(dateStr));
  }
}


// ----- formatting & helpers -----

function buildTitle(role, order) {
  var label = role === 'dropoff' ? '📦 DROP OFF' : '📥 PICK UP';
  return label + ' — ' + (order.job_name || 'TBD') + ' @ ' + (order.venue || 'TBD');
}

function buildDescription(order, thread) {
  var link = 'https://mail.google.com/mail/u/0/#all/' + thread.getId();
  return [
    'Show: '       + (order.job_name || 'TBD'),
    'Venue: '      + (order.venue || 'TBD'),
    'Drop-off: '   + fmtDateTime(order.drop_off_date, order.drop_off_time),
    'Pick-up: '    + fmtDateTime(order.pickup_date, order.pickup_time),
    'Show dates: ' + (order.show_dates || 'TBD'),
    'Notes: '      + (order.notes || 'TBD'),
    '',
    'Source email: ' + link
  ].join('\n');
}

function fmtDateTime(dateStr, timeStr) {
  if (!dateStr) return 'TBD';
  return dateStr + (timeStr ? ' ' + timeStr : '');
}

/** Same job name -> same color every time; spreads jobs across the palette. */
function colorForJob(jobName) {
  var colors = [
    CalendarApp.EventColor.PALE_BLUE, CalendarApp.EventColor.PALE_GREEN,
    CalendarApp.EventColor.MAUVE,     CalendarApp.EventColor.PALE_RED,
    CalendarApp.EventColor.YELLOW,    CalendarApp.EventColor.ORANGE,
    CalendarApp.EventColor.CYAN,      CalendarApp.EventColor.BLUE,
    CalendarApp.EventColor.GREEN,     CalendarApp.EventColor.RED
  ];
  var s = (jobName || 'TBD').toLowerCase(), h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000;
  return colors[h % colors.length];
}

function getCalendar() {
  return CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
}
function getTz() {
  try { return getCalendar().getTimeZone(); } catch (e) { return Session.getScriptTimeZone(); }
}
function safeGetEvent(cal, id) { try { return cal.getEventById(id); } catch (e) { return null; } }
function normalizeTitle(s) { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }
function parseLocalDate(d) { var p = d.split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }
function combineDateTime(d, t) {
  var dp = d.split('-').map(Number), tp = t.split(':').map(Number);
  return new Date(dp[0], dp[1]-1, dp[2], tp[0], tp[1]);
}

function getState(id) {
  var raw = PropertiesService.getScriptProperties().getProperty('t_' + id);
  return raw ? JSON.parse(raw) : null;
}
function saveState(id, obj) {
  PropertiesService.getScriptProperties().setProperty('t_' + id, JSON.stringify(obj));
}


// ===================== TEST HELPERS =====================

/** Confirms your API key + model string work end to end. */
function testApi() {
  var sample = 'From: client@network.com\nSubject: Lakers home game\n\n' +
    'Need 4 cameras + fiber for the Lakers game at Crypto.com Arena. ' +
    'Deliver March 14 by 9am, strike/pickup March 16. Dock B, ask for Mike.';
  Logger.log(JSON.stringify(callClaude(sample), null, 2));
}

/** Forces an immediate pass right now (use for urgent same-day orders). */
function testRun() { processOrderEmails(); }

/** DANGER: wipes the per-thread memory so everything reparses next run. */
function resetState() {
  PropertiesService.getScriptProperties().getKeys().forEach(function (k) {
    if (k.indexOf('t_') === 0) PropertiesService.getScriptProperties().deleteProperty(k);
  });
  Logger.log('Thread state cleared.');
}
