// Join class names, dropping falsy entries — lets primitives merge a base string with conditional
// bits and a caller-passed `className` without pulling in a classnames dependency.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
