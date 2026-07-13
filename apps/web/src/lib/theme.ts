/**
 * Єдине джерело дизайн-токенів «Чат Hi-Fi» — палітра, шрифти й hover-CSS.
 * Використовується і чат-сторінкою, і «вікіпедією» (каталог + сторінка товару),
 * щоб відтінки та інтеракції не розсинхронізувалися між екранами.
 */
export const C = {
  bg: "#f6f2ec",
  ink: "#33291f",
  terra: "#b45f3c",
  terraHi: "#9c4f30",
  dark: "#33291f",
  panel: "#fdfcfa",
  side: "#f1ebe2",
  border: "#e5ddd0",
  borderSoft: "#e9e1d4",
  borderPanel: "#efe9de",
  mut: "#a89b88",
  mut2: "#5c5140",
  mut3: "#8b7f6e",
  userBubble: "#efe5d7",
  chip: "#f3ede4",
  hlBg: "#f7e8db",
  freshBg: "#eef0e5",
  freshInk: "#6f7f5a",
} as const;

export const SERIF = "'Source Serif 4', serif";
export const SANS = "'IBM Plex Sans', sans-serif";

/** Hover/стан-стилі для класів pw-* (інлайн-стилі не покривають :hover). */
export const HOVER_CSS = `
.pw-scroll::-webkit-scrollbar{width:9px;height:9px}
.pw-scroll::-webkit-scrollbar-thumb{background:#dcd2c2;border-radius:9px;border:2px solid transparent;background-clip:content-box}
.pw-scroll::-webkit-scrollbar-track{background:transparent}
.pw-hist{position:relative}
.pw-hist:hover{background:#eee7db}
.pw-hist .pw-del{opacity:0}
.pw-hist:hover .pw-del{opacity:1}
.pw-side-btn:hover{background:#eee7db}
.pw-collapse:hover{background:#e9e1d4}
.pw-newchat:hover{background:#4a3d2e}
.pw-dark-btn:hover:not(:disabled){background:#4a3d2e}
.pw-terra-btn:hover{background:#9c4f30}
.pw-ghost-btn:hover:not(:disabled){background:#f3ede4}
.pw-doc:hover{background:#f7f3ec}
.pw-send:hover:not(:disabled){background:#9c4f30}
.pw-filter-add:hover{color:#5c5140;border-color:#a89b88}
.pw-example:hover{background:#efe5d7;border-color:#d8ccb9}
.pw-wikilink{color:#b45f3c;text-decoration:none}
.pw-wikilink:hover{color:#9c4f30}
.pw-card:hover{border-color:#d8ccb9;box-shadow:0 2px 10px rgba(51,41,31,.06)}
.pw-facet:hover{background:#efe9de}
.pw-facet-on{background:#33291f;color:#f6f2ec}
.pw-facet-on:hover{background:#4a3d2e}
`;
