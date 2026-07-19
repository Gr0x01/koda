/** A document attachment (csv/pdf) as a compact name chip — used by the composer's staged-attachment
 *  row and the transcript's user turn. No preview: the file's bytes live in `.koda/scratch/`; the chip
 *  is just the receipt that it rode along. */
export function FileChip({ name }: { name: string }) {
  return (
    <span className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-text">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-text-muted"
        aria-hidden
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <span className="truncate">{name}</span>
    </span>
  )
}
