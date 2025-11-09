// app.js - menu mobile + filtre projets
// -------------------------------------

(() => {
  "use strict";

  // ===== MENU MOBILE =====
  function initMobileMenu(toggleId, navId) {
    const toggle = document.getElementById(toggleId);
    const nav = document.getElementById(navId);
    if (!toggle || !nav) return;

    const CLS = "show-menu";
    const toggleMenu = () => nav.classList.toggle(CLS);

    toggle.addEventListener("click", toggleMenu);
    // Accessibilité clavier
    toggle.setAttribute("role", "button");
    toggle.setAttribute("aria-expanded", "false");
    toggle.tabIndex = 0;
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMenu();
        toggle.setAttribute("aria-expanded", nav.classList.contains(CLS) ? "true" : "false");
      }
    });
  }

  // ===== SCROLL REVEAL (subtle, accessible) =====
  function initScrollReveal() {
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const groups = [
      { selector: '.section-title', cls: 'reveal reveal-up' },
      { selector: '.section-subtitle', cls: 'reveal reveal-up' },
      { selector: '.about_data', cls: 'reveal reveal-left' },
      { selector: '.about_img', cls: 'reveal reveal-right' },
      { selector: '.services_data', cls: 'reveal reveal-up' },
      { selector: '.project_content', cls: 'reveal reveal-up' },
      { selector: '.contact_card', cls: 'reveal reveal-up' },
      { selector: '.home_data', cls: 'reveal reveal-up' },
    ];

    groups.forEach(({ selector, cls }) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el.classList.contains('reveal')) {
          cls.split(/\s+/).forEach(c => el.classList.add(c));
        }
      });
    });

    const candidates = document.querySelectorAll('.reveal');

    if (prefersReduced) {
      candidates.forEach((el) => el.classList.add('visible'));
      return;
    }

    const io = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('visible');
              io.unobserve(entry.target);
            }
          });
        }, { root: null, rootMargin: '0px 0px -10% 0px', threshold: 0.15 })
      : null;

    if (!io) {
      setTimeout(() => candidates.forEach((el) => el.classList.add('visible')), 50);
      return;
    }

    candidates.forEach((el) => io.observe(el));

    const projectContainer = document.querySelector('.project_container');
    if (projectContainer) {
      const mo = new MutationObserver(() => {
        const all = projectContainer.querySelectorAll('.project_content.reveal:not(.visible)');
        all.forEach((el) => io.observe(el));
      });
      mo.observe(projectContainer, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }

  // ===== HERO TYPED ROLES =====
  function initTypedRoles() {
    const el = document.getElementById('typed-roles');
    if (!el) return;

    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const roles = [
      'Géomaticien',
      'Data Analyste SIG',
      'Télédétection',
      'Web Mapping',
      'Analyse spatiale'
    ];

    if (prefersReduced) {
      el.textContent = roles[0];
      return;
    }

    let i = 0, txt = '', deleting = false;
    const typeDelay = 55;      // typing speed
    const holdDelay = 1200;    // pause at full word
    const delDelay = 35;       // deleting speed

    function loop() {
      const word = roles[i % roles.length];
      if (!deleting) {
        txt = word.slice(0, txt.length + 1);
        el.textContent = txt;
        if (txt === word) {
          deleting = true;
          return setTimeout(loop, holdDelay);
        }
        return setTimeout(loop, typeDelay);
      } else {
        txt = word.slice(0, Math.max(0, txt.length - 1));
        el.textContent = txt;
        if (txt.length === 0) {
          deleting = false;
          i++;
        }
        return setTimeout(loop, delDelay);
      }
    }

    loop();
  }

  // ===== HERO paragraph dynamics (highlight keywords) =====
  function initHeroParagraphDynamics() {
    const el = document.querySelector('.home_profession');
    if (!el) return;

    // Ensure we work on plain text (initTextFixes may have set it)
    const text = el.textContent || '';

    const phrases = [
      'analyse spatiale',
      'télédétection',
      'géomatique',
      "images satellites",
      'applications cartographiques',
      'gestion durable',
      'modélisation environnementale',
      'innovation géospatiale',
      'Géomaticien',
      'Data Analyste SIG'
    ];

    // Replace occurrences with span wrappers (longest first)
    const sorted = [...phrases].sort((a,b)=>b.length - a.length);
    let html = text;
    sorted.forEach((p) => {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${esc})`, 'giu');
      html = html.replace(re, '<span class="kw">$1</span>');
    });
    el.innerHTML = html;

    const kws = el.querySelectorAll('.kw');
    if (!kws.length) return;

    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      kws.forEach(k => k.classList.add('active'));
      return;
    }

    let i = 0;
    function tick() {
      kws.forEach((k, idx) => k.classList.toggle('active', idx === i));
      i = (i + 1) % kws.length;
    }
    tick();
    setInterval(tick, 1600);
  }

  // ===== PROJETS : FILTRE =====
  function initProjectsFilter() {
    const nav = document.querySelector(".project_nav");
    const cards = document.querySelectorAll(".project_content");
    if (!nav || !cards.length) return;

    const FILTERS = new Set(["all", "automation", "web-mapping", "data-engineering"]);

    // Event delegation (un seul écouteur)
    nav.addEventListener("click", (e) => {
      const target = e.target.closest(".project_item");
      if (!target) return;
      applyFilter(target.dataset.filter);
    });

    // Accessibilité clavier
    nav.querySelectorAll(".project_item").forEach((it) => {
      it.tabIndex = 0;
      it.setAttribute("role", "button");
      it.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyFilter(it.dataset.filter);
        }
      });
    });

    function setActiveButton(filter) {
      nav.querySelectorAll(".project_item").forEach((btn) =>
        btn.classList.toggle("active_project", btn.dataset.filter === filter)
      );
    }

    function showCards(filter) {
      cards.forEach((card) => {
        const cat = card.dataset.category || "";
        const show = filter === "all" || filter === cat;
        card.classList.toggle("is-hidden", !show);
      });
    }

    function saveFilter(filter) {
      try { localStorage.setItem("projectsFilter", filter); } catch (_) {}
      if (location.hash !== `#projects-${filter}`) {
        history.replaceState(null, "", `#projects-${filter}`);
      }
    }

    function normalizeFilter(f) {
      return FILTERS.has(f) ? f : "all";
    }

    function applyFilter(filter) {
      const f = normalizeFilter(filter);
      setActiveButton(f);
      showCards(f);
      saveFilter(f);
    }

    // Init (hash > storage > all)
    const fromHash = (location.hash || "").replace("#projects-", "");
    let saved = null;
    try { saved = localStorage.getItem("projectsFilter"); } catch (_) {}
    applyFilter(normalizeFilter(fromHash || saved || "all"));

    // Optionnel : API globale
    window.setProjectsFilter = applyFilter;
  }

  // ===== TEXT FIXES (UTF-8 corrections + labels) =====
  function initTextFixes() {
    // Nav label
    const navAbout = document.querySelector('.nav_list a[href="#a-propos"]');
    if (navAbout) navAbout.textContent = 'À propos';

    // Hero paragraph
    const heroDesc = document.querySelector('.home_profession');
    if (heroDesc) {
      heroDesc.textContent = 'Passionné par la géomatique et la télédétection, je recherche un stage ou une alternance pour mettre en pratique mes compétences en analyse spatiale, traitement d’images satellites et développement d’applications cartographiques. Étudiant en Master Géomatique et Modélisation Spatiale à l’Université Aix‑Marseille, je m’intéresse aux applications de la télédétection pour la gestion durable des ressources naturelles, la modélisation environnementale et l’innovation géospatiale. Géomaticien / Data Analyste SIG.';
    }

    // About paragraph
    const aboutP = document.querySelector('.about_description');
    if (aboutP) {
      const nameSpan = aboutP.querySelector('span');
      const nameHTML = nameSpan ? nameSpan.outerHTML + '\n' : '';
      aboutP.innerHTML = nameHTML +
        'Titulaire d’un Master en géographie physique, je suis actuellement à\n' +
        'Aix‑Marseille Université pour renforcer mes capacités pratiques.\n' +
        'Passionné par la géomatique et la télédétection, j’ai un fort intérêt\n' +
        'pour la forêt, l’aménagement du territoire et l’urbanisme.';
    }

    // Table headers
    document.querySelectorAll('table thead th').forEach((th) => {
      const t = th.textContent.trim().toLowerCase();
      if (t.includes('exp')) th.textContent = 'Expérience';
      if (t.includes('projet')) th.textContent = 'Projets';
      if (t.includes('ann')) th.textContent = 'Années';
    });

    // Fix ranges and labels in table body
    document.querySelectorAll('table tbody td').forEach((td) => {
      td.textContent = td.textContent
        .replace(/\d{4}.+\d{4}/, (m) => m.replace(/[^0-9]/g,'-').replace(/-/g,'–'))
        .replace(/2[^0-9]?3\s*ans/i, '2–3 ans');
    });

    // Contact labels
    const telH3 = Array.from(document.querySelectorAll('.contact_card h3'))
      .find((h) => /t(e|é)l/i.test(h.textContent));
    if (telH3) telH3.textContent = 'Téléphone';

    // LinkedIn label
    const linkedinA = document.querySelector('.contact_card a[href*="linkedin.com"]');
    if (linkedinA) linkedinA.textContent = "erwan-n'guessan";

    // Download buttons
    document.querySelectorAll('a[download]').forEach((a) => {
      if (!a.textContent || /t.l.ch/i.test(a.textContent)) a.textContent = 'Télécharger';
    });

    // Auto-scroll button text normalization
    const btn = document.getElementById('scroll-cards');
    if (btn) {
      const normalize = () => {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('stopper')) btn.textContent = '■ Stopper le défilement';
        else btn.textContent = '▶ Faire défiler les cartes';
      };
      normalize();
      btn.addEventListener('click', () => setTimeout(normalize, 0));
    }
  }

  // ===== SERVICES: dynamic cards (expand + tilt) =====
  function initServiceCards() {
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    document.querySelectorAll('.services_data').forEach((card) => {
      // Expand/collapse
      const toggle = card.querySelector('.button');
      const desc = card.querySelector('.services_description');
      if (toggle && desc) {
        // Normalize label
        if (!/voir|savoir/i.test(toggle.textContent)) toggle.textContent = 'En savoir plus…';
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          const expanded = card.classList.toggle('is-expanded');
          toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          toggle.textContent = expanded ? 'Voir moins' : 'En savoir plus…';
        });
      }

      // Subtle tilt on hover (skip on touch or reduced motion)
      if (!prefersReduced && !coarsePointer) {
        let raf = null;
        const onMove = (e) => {
          const rect = card.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const cx = x / rect.width - 0.5;   // -0.5..0.5
          const cy = y / rect.height - 0.5;
          const maxTilt = 6; // degrees
          const rx = (-cy * maxTilt).toFixed(2) + 'deg';
          const ry = ( cx * maxTilt).toFixed(2) + 'deg';
          const tz = '18px';
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            card.style.setProperty('--rx', rx);
            card.style.setProperty('--ry', ry);
            card.style.setProperty('--tz', tz);
          });
        };
        const reset = () => {
          if (raf) cancelAnimationFrame(raf);
          card.style.removeProperty('--rx');
          card.style.removeProperty('--ry');
          card.style.removeProperty('--tz');
        };
        card.addEventListener('mousemove', onMove);
        card.addEventListener('mouseleave', reset);
      }
    });
  }

  // ===== LANCEMENT SÉCURISÉ =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initMobileMenu("nav-toggle", "nav-menu");
      initScrollReveal();
      initProjectsFilter();
      initTextFixes();
      initHeroParagraphDynamics();
      initServiceCards();
      initTypedRoles();
    });
  } else {
    initMobileMenu("nav-toggle", "nav-menu");
    initScrollReveal();
    initProjectsFilter();
    initTextFixes();
    initHeroParagraphDynamics();
    initServiceCards();
    initTypedRoles();
  }
})();
