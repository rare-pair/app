import { fnv1a } from "./styles";

// The tab icon: a five-bladed pinwheel star, drawn here with our own geometry (no font outlines).
// One blade, turned five times about the centre of a 32 by 32 box. A mid-tone amber fill and a
// dark stroke keep it legible at 16 px on both a light and a dark tab bar. No text, script,
// style or outside reference, so the browser has nothing to fetch.
const BLADE = "M16 16 L16 2.5 Q26.5 5 22.5 15.5 Z";

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${[
  0, 72, 144, 216, 288,
]
  .map(
    (deg) =>
      `<path transform="rotate(${deg} 16 16)" d="${BLADE}" fill="#e8a317" stroke="#4a3200" stroke-width="1.6" stroke-linejoin="round"/>`,
  )
  .join("")}</svg>`;

/** Hashed like the stylesheet, so the response never changes under its URL. */
export const LOGO_PATH = `/assets/logo.${fnv1a(LOGO_SVG)}.svg`;
