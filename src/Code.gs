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
 *   - Has a job name + at least one date? -> placed on the calendar (missing
 *     times/venue just show as TBD). No name or no date -> Orders/Review.
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
  EDIT_PIN:     ''                 // edit code DISABLED — anyone with the link can add/edit/delete ('' = no code)
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

  // One in-memory snapshot of the jobs already on the calendar, so each thread
  // can be checked against them for cross-thread duplicates without re-querying.
  var jobIndex = buildJobIndex(cal);

  var threads = collectThreads(source);
  var summary = { synced: 0, review: 0, errors: 0, merged: 0, scanned: threads.length };

  threads.forEach(function (thread) {
    var id = thread.getId();
    var msgCount = thread.getMessageCount();
    var state = getState(id);

    // Seen before with no new messages:
    //  - already synced to the calendar -> skip (nothing changed, no AI cost).
    //  - still sitting in Needs Review -> re-check it anyway, since it may now
    //    qualify (a name + a date is enough). Skip only if a human dismissed it.
    var pendingReview = state && state.review && !state.dismissed;
    if (state && state.msgCount === msgCount && !pendingReview) return;

    try {
      var order = callClaude(getThreadText(thread));
      // Place it on the calendar as soon as we have a job NAME and a DATE.
      // Missing times, venue, or other details are fine — they show as TBD.
      // Only a missing name or a missing date sends a thread to Needs Review.
      var jobName = order.job_name ? String(order.job_name).trim() : '';
      var hasName = !!jobName && !/^(tbd|n\/?a|none|unknown)$/i.test(jobName);
      var hasDate = !!(order.drop_off_date || order.show_date || order.pickup_date);
      var placeable = order.is_order && hasName && hasDate;

      if (!placeable) {
        thread.addLabel(review);
        // remember count so we don't reparse until a NEW reply arrives
        saveState(id, { msgCount: msgCount, review: true, events: (state && state.events) || {} });
        summary.review++;
        return;
      }

      thread.removeLabel(review); // clear any prior flag now that we have dates

      // Smart de-dup: is another thread's job actually the SAME job? If so, adopt
      // its events, merge details (newest value wins, nothing lost), and drop any
      // stray duplicate — instead of creating a second set of events for it.
      var myEvents = (state && state.events) || {};
      var dup = findDuplicateJob(cal, order, collectEventIds(myEvents), jobIndex);
      if (dup) {
        order = mergeOrders(dup.order, order);
        myEvents = adoptCanonical(cal, myEvents, dup.events);
        summary.merged++;
        Logger.log('Duplicate job merged across threads: ' + order.job_name);
      }

      var events = syncEvents(cal, order, thread, myEvents);
      jobIndex.push(indexEntry(order, events)); // keep later threads aware of it
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
    '"drop_off_location":string|null,"show_date":"YYYY-MM-DD"|null,' +
    '"pickup_date":"YYYY-MM-DD"|null,"pickup_time":"HH:MM"|null,' +
    '"pickup_location":string|null,"show_dates":string|null,"notes":string|null}\n\n' +
    'Rules:\n' +
    '- is_order is true if this thread is a genuine equipment rental order or show booking for ' +
    'Apache Rental Group. A partial order still counts — it is an order even if the time, venue, ' +
    'or other details are missing.\n' +
    '- job_name: the show / event / production / client job name. Return null ONLY if there is no ' +
    'identifiable job or show name at all.\n' +
    '- Dates use YYYY-MM-DD; resolve relative dates ("next Friday") against today. Only return a ' +
    'date you can actually determine from the thread. If a date is not stated or would be a pure ' +
    'guess, return null — do NOT invent one. (A missing date is what sends a thread to manual ' +
    'review, which is correct.)\n' +
    '- A job needs only a name and ONE date (drop-off OR pickup) to go on the calendar. Times, ' +
    'venue, show_dates, and notes are OPTIONAL — if not stated, return null (do NOT write "TBD"; ' +
    'the system fills that in). Missing times or venue must NOT stop you from returning the ' +
    'date(s) you do know.\n' +
    '- Use 24-hour times.\n' +
    '- drop_off_location: where the equipment should be DELIVERED / dropped off (address, ' +
    'building, dock, room, or venue). pickup_location: where it should be PICKED UP from / ' +
    'returned to. Capture each ONLY if the email states it; otherwise null. They can differ ' +
    'from each other and from the venue.\n' +
    '- show_date: the date the SHOW / event / production itself happens (its first day if it ' +
    'runs multiple days). pickup_date: the date the gear is actually PICKED UP / returned. For ' +
    'most local jobs the crew strikes and picks up right when the show ends, so pickup_date ' +
    'equals show_date — if the email gives a show day and implies a same-day/local strike, set ' +
    'BOTH to that date. For shipped or out-of-town jobs the gear comes back days later, so ' +
    'show_date is the show day and pickup_date is the later return date (or null if not stated ' +
    'yet). Only set show_date if the thread actually indicates when the show is; otherwise null.\n' +
    '- confidence (high|medium|low) reflects how sure you are about the dates; it is ' +
    'informational only and does not need to be high for the order to be placed.\n' +
    '- notes: capture any other useful specifics the email states, formatted as SHORT labeled ' +
    'lines separated by newlines, ONE item per line as "Label: detail". Use concise labels like ' +
    'Contact, Dock, Loading, Equipment, PO, Account, Parking, or Special. Example: ' +
    '"Contact: Mike 305-555-0101\\nDock: B, rear\\nEquipment: 4 cameras + fiber\\nPO: 12345". ' +
    'Only include lines the email actually states. If nothing extra is stated, return null.';

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


// The event roles a job can have on the calendar. show+pickup collapse into the
// single "showpickup" role when they fall on the same day (the common local case);
// they split into separate "show" and "pickup" roles for shipped / out-of-town jobs.
var ALL_ROLES = ['dropoff', 'show', 'pickup', 'showpickup'];

/**
 * Decide which dated events a job needs, from its dates. Returns a map of
 * role -> { date, time }. Drop-off is always its own event. Show + pick-up merge
 * onto one event when they share a day; otherwise each stands alone.
 */
function planRoles(dropDate, dropTime, showDate, pickDate, pickTime) {
  var plan = {};
  if (dropDate) plan.dropoff = { date: dropDate, time: dropTime || null };
  if (showDate && pickDate && showDate === pickDate) {
    plan.showpickup = { date: pickDate, time: pickTime || null };   // strike/pickup on show day
  } else {
    if (showDate) plan.show   = { date: showDate, time: null };      // show day stands alone
    if (pickDate) plan.pickup = { date: pickDate, time: pickTime || null };
  }
  return plan;
}

/** Which role an event's title represents (or null if it isn't a job event). */
function roleOfTitle(title) {
  title = title || '';
  if (title.indexOf('📦') === 0) return 'dropoff';
  if (title.indexOf('🎬') === 0) return title.indexOf('📥') > -1 ? 'showpickup' : 'show';
  if (title.indexOf('📥') === 0) return 'pickup';
  return null;
}
function isJobEvent(ev) { return !!roleOfTitle(ev.getTitle()); }

/** Create or update every dated event a job needs; delete any role it no longer has. */
function syncEvents(cal, order, thread, events) {
  var plan = planRoles(order.drop_off_date, order.drop_off_time,
                       order.show_date, order.pickup_date, order.pickup_time);
  ALL_ROLES.forEach(function (role) {
    var p = plan[role];
    events[role] = syncRole(cal, role, p && p.date, p && p.time, order, thread, events[role]);
  });
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


// ===================== SMART CROSS-THREAD DE-DUP =====================
// Two different email threads can be about the SAME job (a forward, a reply chain
// that split, a re-quote). We match on job name + venue + date proximity; when the
// match is borderline we ask Claude a single yes/no to confirm. On a confirmed
// match we adopt the existing events, merge details, and drop the stray duplicate.

/** Snapshot every job already on the calendar as matchable index entries. */
function buildJobIndex(cal) {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  var end   = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  var groups = {};
  cal.getEvents(start, end).forEach(function (ev) {
    var role = roleOfTitle(ev.getTitle());
    if (!role) return;
    var order = jobFromOneEvent(ev);
    var key = identityKey(order);
    if (!groups[key]) groups[key] = { order: order, events: {} };
    groups[key].events[role] = ev.getId();
  });
  return Object.keys(groups).map(function (k) {
    return indexEntry(groups[k].order, groups[k].events);
  });
}

/** Rebuild an order object from one event's stored "Key: value" description. */
function jobFromOneEvent(ev) {
  var f = parseEventDescription(ev.getDescription() || '');
  var drop = splitDateTime(f['Drop-off']);
  var pick = splitDateTime(f['Pick-up']);
  var show = splitDateTime(f['Show day']);
  return {
    is_order: true,
    job_name: clean(f['Show']) || stripTitle(ev.getTitle() || ''),
    venue: clean(f['Venue']),
    drop_off_date: drop.date, drop_off_time: drop.time,
    drop_off_location: clean(f['Drop-off location']),
    show_date: show.date,
    pickup_date: pick.date, pickup_time: pick.time,
    pickup_location: clean(f['Pick-up location']),
    show_dates: clean(f['Show dates']),
    notes: decodeNotes(clean(f['Notes']))
  };
}

function indexEntry(order, events) {
  return { order: order, events: events, ids: collectEventIds(events) };
}

/** All non-empty event IDs in an events map, as a lookup set. */
function collectEventIds(events) {
  var ids = {};
  if (events) Object.keys(events).forEach(function (r) { if (events[r]) ids[events[r]] = true; });
  return ids;
}

/** A grouping key so one job's drop-off/show/pick-up events collapse to one entry. */
function identityKey(o) {
  return nameNorm(o.job_name) + '|' + nameNorm(o.venue) + '|' + datesOf(o).slice().sort().join(',');
}
function datesOf(o) { return [o.drop_off_date, o.show_date, o.pickup_date].filter(Boolean); }
function nameNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Find an existing job that is really the SAME job as `order` (or null). */
function findDuplicateJob(cal, order, myIds, jobIndex) {
  var best = null, bestScore = -1, bestNeedsAI = false;
  for (var i = 0; i < jobIndex.length; i++) {
    var e = jobIndex[i];
    if (sharesId(e.ids, myIds)) continue;             // that's my own event set
    var dateHit = sharedDate(order, e.order);
    if (dateHit === 'none') continue;                 // no shared/near date -> different job
    var name = nameSim(order.job_name, e.order.job_name);
    if (name < 0.34) continue;    // only a trivial word in common -> different job (the AI
                                  // confirm below is the safety net for everything above this)
    var score = name + (dateHit === 'exact' ? 0.2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
      bestNeedsAI = !(name >= 0.85 && dateHit === 'exact'); // only clear matches skip the AI check
    }
  }
  if (!best) return null;
  if (bestNeedsAI && !aiSameJob(order, best.order)) return null;
  return { order: best.order, events: best.events };
}

function sharesId(a, b) { for (var k in a) { if (b[k]) return true; } return false; }

/** Token-overlap similarity of two job names (0..1), tolerant of extra words. */
function nameSim(a, b) {
  var na = nameNorm(a), nb = nameNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  var ta = na.split(' '), tb = nb.split(' ');
  var setB = {}; tb.forEach(function (w) { setB[w] = true; });
  var inter = 0, seen = {};
  ta.forEach(function (w) { if (setB[w] && !seen[w]) { inter++; seen[w] = true; } });
  var uniq = {}; ta.concat(tb).forEach(function (w) { uniq[w] = true; });
  var jac = inter / Object.keys(uniq).length;
  var contain = (na.indexOf(nb) > -1 || nb.indexOf(na) > -1) ? 0.85 : 0;
  return Math.max(jac, contain);
}

/** 'exact' if any two dates coincide, 'close' if within 2 days, else 'none'. */
function sharedDate(a, b) {
  var da = datesOf(a), db = datesOf(b), close = false;
  for (var i = 0; i < da.length; i++) {
    for (var j = 0; j < db.length; j++) {
      var diff = Math.abs(dayDiff(da[i], db[j]));
      if (diff === 0) return 'exact';
      if (diff <= 2) close = true;
    }
  }
  return close ? 'close' : 'none';
}
function dayDiff(d1, d2) {
  return Math.round((parseLocalDate(d1).getTime() - parseLocalDate(d2).getTime()) / 86400000);
}

/** Single cheap Claude yes/no: are these two jobs the same real job? */
function aiSameJob(a, b) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return false;   // can't confirm -> don't merge (safer than a wrong merge)
  function line(o) {
    return 'name="' + (o.job_name || '') + '", venue="' + (o.venue || '') +
           '", drop-off=' + (o.drop_off_date || '-') + ', show=' + (o.show_date || '-') +
           ', pickup=' + (o.pickup_date || '-');
  }
  var user =
    'Two broadcast-equipment rental jobs came from different email threads. Are they the SAME ' +
    'real job (same production / booking), just described differently — as opposed to two ' +
    'different jobs that merely look similar? Weigh the name wording, venue, and dates together.\n' +
    'JOB A: ' + line(a) + '\nJOB B: ' + line(b) + '\n' +
    'Return ONLY minified JSON: {"same_job":true|false}.';
  try {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: CONFIG.MODEL, max_tokens: 64,
        messages: [{ role: 'user', content: user }]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return false;
    var data = JSON.parse(res.getContentText());
    var out = data.content.filter(function (x) { return x.type === 'text'; })
                          .map(function (x) { return x.text; }).join('')
                          .replace(/```json|```/g, '').trim();
    return !!JSON.parse(out).same_job;
  } catch (e) {
    return false;
  }
}

/** Merge two versions of the same job: the newest (incoming) wins per field; gaps
 *  fall back to the existing value; notes are unioned so nothing is lost. */
function mergeOrders(existing, incoming) {
  function pick(a, b) { return (a !== null && a !== undefined && a !== '') ? a : b; }
  return {
    is_order: true,
    confidence: incoming.confidence || existing.confidence,
    job_name: pick(incoming.job_name, existing.job_name),
    venue: pick(incoming.venue, existing.venue),
    drop_off_date: pick(incoming.drop_off_date, existing.drop_off_date),
    drop_off_time: pick(incoming.drop_off_time, existing.drop_off_time),
    drop_off_location: pick(incoming.drop_off_location, existing.drop_off_location),
    show_date: pick(incoming.show_date, existing.show_date),
    pickup_date: pick(incoming.pickup_date, existing.pickup_date),
    pickup_time: pick(incoming.pickup_time, existing.pickup_time),
    pickup_location: pick(incoming.pickup_location, existing.pickup_location),
    show_dates: pick(incoming.show_dates, existing.show_dates),
    notes: mergeNotes(existing.notes, incoming.notes)
  };
}
function mergeNotes(a, b) {
  var lines = [], seen = {};
  [a, b].forEach(function (block) {
    String(block == null ? '' : block).split(/\r?\n/).forEach(function (ln) {
      var t = ln.trim(); if (!t) return;
      var key = t.toLowerCase();
      if (!seen[key]) { seen[key] = true; lines.push(t); }
    });
  });
  return lines.join('\n');
}

/** Take over the duplicate's canonical events; delete any stray events I made. */
function adoptCanonical(cal, myEvents, dupEvents) {
  var keep = collectEventIds(dupEvents);
  if (myEvents) {
    Object.keys(myEvents).forEach(function (r) {
      var id = myEvents[r];
      if (id && !keep[id]) { var e = safeGetEvent(cal, id); if (e) e.deleteEvent(); }
    });
  }
  var out = {};
  Object.keys(dupEvents).forEach(function (r) { out[r] = dupEvents[r]; });
  return out;
}


// ----- formatting & helpers -----

var ROLE_LABELS = {
  dropoff:    '📦 DROP OFF',
  show:       '🎬 SHOW DAY',
  pickup:     '📥 PICK UP',
  showpickup: '🎬 SHOW / 📥 PICK UP'
};
function buildTitle(role, order) {
  var label = ROLE_LABELS[role] || ROLE_LABELS.pickup;
  return label + ' — ' + (order.job_name || 'TBD') + ' @ ' + (order.venue || 'TBD');
}

function buildDescription(order, thread) {
  var link = 'https://mail.google.com/mail/u/0/#all/' + thread.getId();
  return [
    'Show: '       + (order.job_name || 'TBD'),
    'Venue: '      + (order.venue || 'TBD'),
    'Drop-off: '   + fmtDateTime(order.drop_off_date, order.drop_off_time),
    'Drop-off location: ' + (order.drop_off_location || 'TBD'),
    'Show day: '   + (order.show_date || 'TBD'),
    'Pick-up: '    + fmtDateTime(order.pickup_date, order.pickup_time),
    'Pick-up location: '  + (order.pickup_location || 'TBD'),
    'Show dates: ' + (order.show_dates || 'TBD'),
    'Notes: '      + (order.notes ? encodeNotes(order.notes) : 'TBD'),
    '',
    'Source email: ' + link
  ].join('\n');
}

/** Notes can be multi-line; keep them on ONE description line by escaping newlines. */
function encodeNotes(s) { return String(s == null ? '' : s).replace(/\r?\n/g, '\\n'); }
function decodeNotes(s) { return String(s == null ? '' : s).replace(/\\n/g, '\n'); }

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
