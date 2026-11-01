/** Quotes text as one word for a POSIX shell. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", `'''`)}'`;
}
