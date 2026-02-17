// Time helpers used by admin UI routes

/**
 * Format an ISO date/time string into a local, human-friendly string.
 * Example output: "2026-02-17 16:55"
 */
export function formatIsoDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  const pad = (n: number) => String(n).padStart(2, "0");

  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
