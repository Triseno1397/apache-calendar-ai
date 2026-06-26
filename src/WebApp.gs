/**
 * Apache Rental Group — Mobile Web View
 * =====================================
 * A read-only, phone-friendly view of every job on the shared calendar.
 * Coworkers open the deployed web-app URL (no login), see the upcoming jobs
 * with all the details, and can "Add to Home Screen" to use it like an app.
 *
 *   doGet()   -> serves the mobile UI (src/Index.html)
 *   getJobs() -> called from the page via google.script.run; returns the
 *                current jobs parsed from the calendar events that the email
 *                automation writes.
 *
 * Deploy:  clasp deploy   (manifest sets executeAs=owner, access=anonymous)
 * The events are READ from the same calendar getCalendar() returns in Code.gs.
 */

/** Serve the mobile web UI. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('src/Index')
    .setTitle('Apache Rental — Jobs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Return the current jobs as plain objects for the page.
 * Reads a window of calendar events, keeps only the automation's
 * drop-off / pick-up events, and parses each one's description.
 */
function getJobs() {
  var cal = getCalendar();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 31);
  var end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 365);

  var events = cal.getEvents(start, end);
  var seen = {};
  var jobs = [];

  events.forEach(function (ev) {
    var title = ev.getTitle() || '';
    // Only our automation's events start with the drop-off / pick-up markers.
    if (title.indexOf('📦') !== 0 && title.indexOf('📥') !== 0) return;

    var f = parseEventDescription(ev.getDescription() || '');
    var drop = splitDateTime(f['Drop-off']);
    var pick = splitDateTime(f['Pick-up']);

    var job = clean(f['Show']) || stripTitle(title);
    var venue = clean(f['Venue']);

    // Collapse the drop-off event and pick-up event of the same job into one.
    var key = [job, venue, drop.date, drop.time, pick.date, pick.time].join('|');
    if (seen[key]) return;
    seen[key] = true;

    jobs.push({
      job: job,
      venue: venue,
      dropOffDate: drop.date,
      dropOffTime: drop.time,
      pickUpDate: pick.date,
      pickUpTime: pick.time,
      showDates: clean(f['Show dates']),
      notes: clean(f['Notes'])
    });
  });

  return { jobs: jobs, generatedAt: new Date().toISOString() };
}

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
