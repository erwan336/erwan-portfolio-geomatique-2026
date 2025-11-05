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

  // ===== LANCEMENT SÉCURISÉ =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initMobileMenu("nav-toggle", "nav-menu");
      initProjectsFilter();
    });
  } else {
    initMobileMenu("nav-toggle", "nav-menu");
    initProjectsFilter();
  }
})();
