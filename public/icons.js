// A small hand-drawn line-icon set (24x24, stroke = currentColor) replacing
// the emoji this app used everywhere (📦 🧪 🔔 ✦) — consistent weight,
// themed to the "Mission Control" visual identity (src/routes/pages.ts,
// public/styles.css). Kept as plain template strings (no build step, no
// icon-font dependency) so any view can drop one into innerHTML.

function svg(inner, extra = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
}

export const icons = {
  brand: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2Z"/></svg>`,

  warehouse: svg(`<path d="M3 8.5 12 4l9 4.5"/><path d="M3 8.5v10L12 22l9-3.5v-10"/><path d="M3 8.5 12 13l9-4.5"/><path d="M12 13v9"/>`),

  quality: svg(`<path d="M9 3h6"/><path d="M10 3v5.5L4.8 18a2 2 0 0 0 1.75 3h10.9a2 2 0 0 0 1.75-3L14 8.5V3"/><path d="M7.5 14.5h9"/>`),

  bell: svg(`<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/>`),

  logout: svg(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`),

  search: svg(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`),

  plus: svg(`<path d="M12 5v14M5 12h14"/>`),

  arrowRight: svg(`<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>`),

  navReceive: svg(`<path d="M12 3v10m0 0 4-4m-4 4-4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>`),
  navTodo: svg(`<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>`),
  navHistory: svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l4 2"/>`),
  navCodes: svg(`<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>`),
  navSpecs: svg(`<path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/>`),
  navMasterdata: svg(`<path d="M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Z"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>`),

  check: svg(`<path d="M4 12.5 9 17.5 20 6.5"/>`),
  alertCircle: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16v.01"/>`),
  x: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),

  inbox: svg(`<path d="M3 12h4.5l1.5 3h6l1.5-3H21"/><path d="M5.5 5h13l2.5 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2.5-7Z"/>`),
};

export const navIcon = (routeId) =>
  ({
    receive: icons.navReceive,
    todo: icons.navTodo,
    history: icons.navHistory,
    codes: icons.navCodes,
    specs: icons.navSpecs,
    masterdata: icons.navMasterdata,
  })[routeId] ?? "";
