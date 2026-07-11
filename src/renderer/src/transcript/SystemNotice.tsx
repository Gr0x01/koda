/** Session start, cost, errors — quiet metadata, not part of the conversation. */
export function SystemNotice({ text }: { text: string }) {
  return (
    <p className="py-1 text-center text-[11px] uppercase tracking-wider text-text-muted">{text}</p>
  )
}
