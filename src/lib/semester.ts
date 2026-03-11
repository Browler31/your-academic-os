/**
 * Parses semester info from course short_name or name.
 * Examples:
 *   "w.BA.XX.1FER-RE.XX.2026-FS" → { semester: "FS 2026", label: "Frühlingssemester 2026" }
 *   "Staatsrecht I (2025-HS)" → { semester: "HS 2025", label: "Herbstsemester 2025" }
 */
export function parseSemester(name: string, shortName?: string | null): { semester: string; label: string; isCurrent: boolean } {
  const source = shortName || name;

  // Match patterns like "2026-FS" or "2025-HS"
  const match = source.match(/(\d{4})-(FS|HS)/i);
  if (match) {
    const year = match[1];
    const term = match[2].toUpperCase();
    const semester = `${term} ${year}`;
    const label = term === "FS" ? `Frühlingssemester ${year}` : `Herbstsemester ${year}`;
    const isCurrent = isCurrentSemester(term, parseInt(year));
    return { semester, label, isCurrent };
  }

  return { semester: "Andere", label: "Andere Kurse", isCurrent: false };
}

function isCurrentSemester(term: string, year: number): boolean {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12

  if (term === "FS") {
    // FS runs roughly Feb–July
    return year === currentYear && currentMonth >= 2 && currentMonth <= 7;
  } else {
    // HS runs roughly Sept–Jan
    return (year === currentYear && currentMonth >= 9) || (year === currentYear - 1 && currentMonth <= 1);
  }
}

/**
 * Cleans up Moodle short names into readable course labels.
 * "w.BA.XX.1FER-RE.XX.2026-FS" → "FER" (extracts the meaningful abbreviation)
 * Falls back to the full name.
 */
export function cleanCourseName(name: string, shortName?: string | null): string {
  // Already clean names (no module code pattern)
  if (!shortName || !shortName.includes("w.BA")) {
    return name.replace(/\s*\(\d{4}-[FH]S\)\s*$/, "").trim();
  }

  // Extract from pattern like "w.BA.XX.1FER-RE.XX.2026-FS"
  // We want the full course name without the semester suffix
  return name.replace(/\s*\(\d{4}-[FH]S\)\s*$/, "").trim();
}

/**
 * Groups items by a key function.
 */
export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

/**
 * Sort semesters: current first, then most recent.
 */
export function sortSemesters(semesters: string[]): string[] {
  return semesters.sort((a, b) => {
    if (a === "Andere") return 1;
    if (b === "Andere") return -1;

    const [termA, yearA] = a.split(" ");
    const [termB, yearB] = b.split(" ");

    // Most recent year first
    if (yearA !== yearB) return parseInt(yearB) - parseInt(yearA);
    // FS before HS in same year (FS is more recent within a calendar year)
    if (termA === "FS" && termB === "HS") return -1;
    if (termA === "HS" && termB === "FS") return 1;
    return 0;
  });
}
