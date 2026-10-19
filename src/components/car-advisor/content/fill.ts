/** Replaces {name} placeholders in a copy string. Unknown placeholders are left as they are. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
