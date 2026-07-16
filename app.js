(function(){
    var toggle = document.getElementById('navToggle');
    var menu = document.getElementById('mobileMenu');
    if(!toggle || !menu) return;

    toggle.addEventListener('click', function(){
      var open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Close the menu when a link is chosen.
    menu.addEventListener('click', function(e){
      if(e.target.tagName === 'A'){
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded','false');
      }
    });

    // Close on Escape, return focus to the toggle.
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && menu.classList.contains('open')){
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded','false');
        toggle.focus();
      }
    });
  })();

  // ---------- theme toggle wiring ----------
  (function(){
    var KEY = 'knoxdsa-theme';
    var root = document.documentElement;
    var buttons = [
      document.getElementById('themeToggle'),
      document.getElementById('themeToggleMobile')
    ].filter(Boolean);
    if(!buttons.length) return;

    function current(){
      return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function sync(){
      var isDark = current() === 'dark';
      // Label + state describe the action available, matching the visible icon.
      var label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
      buttons.forEach(function(b){
        b.setAttribute('aria-label', label);
        b.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      });
    }

    function setTheme(next){
      root.setAttribute('data-theme', next);
      try{ localStorage.setItem(KEY, next); }catch(e){}
      sync();
    }

    buttons.forEach(function(b){
      b.addEventListener('click', function(){
        setTheme(current() === 'dark' ? 'light' : 'dark');
      });
    });

    // Follow the operating system live: if the visitor flips their device
    // light/dark setting, the site switches to match (and keeps the stored
    // choice in sync). A manual toggle still works; it holds until the next
    // OS change.
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if(mq){
      var onOSChange = function(e){ setTheme(e.matches ? 'dark' : 'light'); };
      if(mq.addEventListener){ mq.addEventListener('change', onOSChange); }
      else if(mq.addListener){ mq.addListener(onOSChange); }
    }

    // Initialize state from the theme the head bootstrap already applied.
    sync();
  })();

  // ====================================================================
  // POLISH LAYER  ("show the potential" behaviors). All feature-detect,
  // all respect prefers-reduced-motion, all no-op when their hooks are
  // absent, so every page can share this one file.
  // ====================================================================
  var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- (1) live countdown to the next General Meeting ----------
  // The General Meeting is the 4th Monday of the month at 6:00 PM. We
  // compute it from scratch so the countdown stays correct as dates pass.
  (function(){
    var els = document.querySelectorAll('[data-countdown]');
    if(!els.length) return;
    var dateEls = document.querySelectorAll('[data-meeting-date]');

    function fourthMonday(year, month){
      var first = new Date(year, month, 1);
      var firstMonday = 1 + ((8 - first.getDay()) % 7); // 1..7
      return new Date(year, month, firstMonday + 21, 18, 0, 0, 0);
    }
    function nextMeeting(now){
      var m = fourthMonday(now.getFullYear(), now.getMonth());
      if(now.getTime() > m.getTime() + 2 * 3600 * 1000){
        var nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        m = fourthMonday(nm.getFullYear(), nm.getMonth());
      }
      return m;
    }
    function phrase(ms, meeting){
      if(ms <= 0) return { text:'Happening now', cls:'live' };
      var mins = Math.round(ms / 60000);
      if(mins < 60) return { text:'In ' + mins + (mins === 1 ? ' min' : ' min'), cls:'soon' };
      var hours = Math.round(ms / 3600000);
      if(hours < 24) return { text:'In ' + hours + (hours === 1 ? ' hour' : ' hours'), cls:'soon' };
      var days = Math.round(ms / 86400000);
      if(days < 14) return { text:'In ' + days + ' days', cls:'' };
      var weeks = Math.round(days / 7);
      return { text:'In ' + weeks + ' weeks', cls:'' };
    }
    function tick(){
      var now = new Date();
      var meeting = nextMeeting(now);
      var startMs = meeting.getTime() - now.getTime();
      var live = now.getTime() >= meeting.getTime() && now.getTime() <= meeting.getTime() + 2 * 3600 * 1000;
      var p = live ? { text:'Happening now', cls:'live' } : phrase(startMs, meeting);
      if(dateEls.length){
        var dstr = meeting.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }).replace(',', '');
        dateEls.forEach(function(el){ el.textContent = dstr; });
      }
      els.forEach(function(el){
        el.textContent = p.text;
        el.classList.remove('bcount--soon', 'bcount--live');
        if(p.cls) el.classList.add('bcount--' + p.cls);
      });
    }
    tick();
    setInterval(tick, 30000);
  })();

  // ---------- live recurring dates: keep every meeting/event date current on its own ----------
  // Any element with data-recur="<nth><WD>" (e.g. "4MO" = 4th Monday, "2MO", "3TH")
  // is filled with the NEXT occurrence, formatted by data-fmt. So the demo never goes stale.
  (function(){
    var nodes = document.querySelectorAll('[data-recur]');
    if(!nodes.length) return;
    var WD = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
    function nthWeekday(y, m, wd, n){
      var first = new Date(y, m, 1);
      var firstWd = 1 + ((wd - first.getDay() + 7) % 7);
      return new Date(y, m, firstWd + (n - 1) * 7, 18, 0, 0, 0);
    }
    function nextOccur(recur, now){
      var n = parseInt(recur, 10) || 1;
      var wd = WD[recur.replace(/^[0-9]+/, '')]; if(wd === undefined) wd = 1;
      var d = nthWeekday(now.getFullYear(), now.getMonth(), wd, n);
      if(now.getTime() > d.getTime() + 2 * 3600 * 1000){
        var nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        d = nthWeekday(nm.getFullYear(), nm.getMonth(), wd, n);
      }
      return d;
    }
    function fmt(d, kind){
      if(kind === 'mo') return d.toLocaleDateString('en-US', { month:'short' });
      if(kind === 'dy') return String(d.getDate());
      if(kind === 'yr') return String(d.getFullYear());
      if(kind === 'monthname') return d.toLocaleDateString('en-US', { month:'long' });
      if(kind === 'long') return d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
      if(kind === 'longyear') return d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
      if(kind === 'monthdayyear') return d.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
      return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }).replace(',', '');
    }
    var now = new Date();
    nodes.forEach(function(el){
      el.textContent = fmt(nextOccur(el.getAttribute('data-recur'), now), el.getAttribute('data-fmt') || 'short');
    });
    // keep any .event-list in chronological order as dates roll forward
    document.querySelectorAll('.event-list').forEach(function(list){
      var evs = Array.prototype.slice.call(list.children).filter(function(c){ return c.classList && c.classList.contains('event'); });
      evs.forEach(function(ev){ var h = ev.querySelector('[data-recur]'); ev._t = h ? nextOccur(h.getAttribute('data-recur'), now).getTime() : 0; });
      evs.sort(function(a, b){ return a._t - b._t; });
      evs.forEach(function(ev){ list.appendChild(ev); });
    });
  })();

  // ---------- (4) rotating "this week" ticker ----------
  (function(){
    var box = document.querySelector('[data-ticker]');
    if(!box) return;
    var items = box.querySelectorAll('.titem');
    if(items.length < 2) return;
    items.forEach(function(it, i){ it.classList.toggle('is-on', i === 0); });
    if(REDUCE) return; // hold on the first item under reduced motion
    var i = 0;
    setInterval(function(){
      items[i].classList.remove('is-on');
      i = (i + 1) % items.length;
      items[i].classList.add('is-on');
    }, 3200);
  })();

  // ---------- (3) scroll reveal + (10) goal-bar fill on enter ----------
  (function(){
    var goals = document.querySelectorAll('.goal');
    var sections = REDUCE ? [] : document.querySelectorAll('main .section');
    sections.forEach(function(s){ s.classList.add('reveal'); });

    var targets = [];
    sections.forEach(function(s){ targets.push(s); });
    goals.forEach(function(g){ targets.push(g); });
    if(!targets.length) return;

    if(!('IntersectionObserver' in window)){
      targets.forEach(function(t){ t.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin:'0px 0px -8% 0px', threshold:0.08 });
    targets.forEach(function(t){ io.observe(t); });
  })();

  // ---------- (2) real-feeling success states on the mock forms ----------
  (function(){
    var forms = document.querySelectorAll('form[action="#"]');
    forms.forEach(function(f){
      f.addEventListener('submit', function(e){
        e.preventDefault();
        if(f.classList.contains('is-hidden')) return;
        var label = f.getAttribute('data-success-label') || 'You’re on the list';
        var msg = f.getAttribute('data-success') ||
          'Thanks. In the live site this submits to the chapter’s Action Network and you’d get a confirmation email within a minute.';
        var box = document.createElement('div');
        box.className = 'form-success';
        box.setAttribute('role', 'status');
        box.setAttribute('tabindex', '-1');
        var strong = document.createElement('span');
        strong.className = 'clabel';
        strong.textContent = label;
        box.appendChild(strong);
        box.appendChild(document.createTextNode(msg));
        f.classList.add('is-hidden');
        f.parentNode.insertBefore(box, f.nextSibling);
        box.focus();
      });
    });
  })();

  // ---------- (15) dismissible prototype ribbon ----------
  (function(){
    var ribbon = document.querySelector('.proto-ribbon');
    if(!ribbon) return;
    var KEY = 'knoxdsa-proto-ribbon';
    try{ if(localStorage.getItem(KEY) === 'dismissed') ribbon.hidden = true; }catch(e){}
    var x = ribbon.querySelector('[data-ribbon-dismiss]');
    if(x){
      x.addEventListener('click', function(){
        ribbon.hidden = true;
        try{ localStorage.setItem(KEY, 'dismissed'); }catch(e){}
      });
    }
  })();

  // ---------- (11) interactive map pins ----------
  (function(){
    var pins = document.querySelectorAll('.knoxmap .pin');
    if(!pins.length) return;
    function closeAll(except){
      pins.forEach(function(q){
        if(q !== except){ q.classList.remove('is-open'); q.setAttribute('aria-expanded', 'false'); }
      });
    }
    pins.forEach(function(p){
      p.setAttribute('aria-expanded', 'false');
      p.addEventListener('click', function(e){
        e.stopPropagation();
        var open = p.classList.contains('is-open');
        closeAll(p);
        p.classList.toggle('is-open', !open);
        p.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
    });
    document.addEventListener('click', function(){ closeAll(null); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeAll(null); });
  })();

  // ---------- (6) "publish from a form" demo ----------
  (function(){
    var pd = document.querySelector('[data-publish-demo]');
    if(!pd) return;
    var btn = pd.querySelector('[data-publish]');
    if(!btn) return;
    var titleEl = pd.querySelector('[data-field="title"]');
    var bodyEl = pd.querySelector('[data-field="body"]');
    var deploy = pd.querySelector('[data-deploy]');
    var deployText = pd.querySelector('[data-deploy-text]');
    var live = pd.querySelector('[data-live]');
    var empty = pd.querySelector('[data-live-empty]');

    function val(el){ return el ? (el.value.trim() || el.getAttribute('placeholder') || '') : ''; }

    btn.addEventListener('click', function(){
      var t = val(titleEl) || 'Untitled post';
      var b = val(bodyEl) || 'Add a sentence or two and hit Publish again.';
      if(deploy){ deploy.hidden = false; deploy.classList.remove('is-done'); deploy.classList.add('is-running'); }
      if(deployText) deployText.textContent = 'Publishing. Building the site…';
      btn.disabled = true;
      var label = btn.textContent; btn.textContent = 'Publishing…';
      var delay = REDUCE ? 0 : 1300;
      setTimeout(function(){
        if(deploy){ deploy.classList.remove('is-running'); deploy.classList.add('is-done'); }
        if(deployText) deployText.textContent = 'Published. Live in about a minute.';
        if(empty) empty.hidden = true;
        if(live){
          live.hidden = false;
          var lt = live.querySelector('[data-live-title]'); if(lt) lt.textContent = t;
          var lb = live.querySelector('[data-live-body]'); if(lb) lb.textContent = b;
          var ld = live.querySelector('[data-live-date]'); if(ld) ld.textContent = 'Just now';
        }
        btn.disabled = false; btn.textContent = label;
      }, delay);
    });
  })();

  // ---------- (16) print the flyer ----------
  (function(){
    document.querySelectorAll('[data-print]').forEach(function(b){
      b.addEventListener('click', function(){ window.print(); });
    });
  })();
