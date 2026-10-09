/**
 * Removes every Caddy placeholder, `{` up to the next `}`, from a value that
 * ends up in generated configuration, so a request cannot inject one. An
 * unclosed `{` stays. Linear in the length of the value, where the equivalent
 * /\{[^}]*\}/g is quadratic on a long run of braces.
 */
export function stripPlaceholders(value: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = value.indexOf("{", from);
    if (open === -1) return out + value.slice(from);
    const close = value.indexOf("}", open + 1);
    if (close === -1) return out + value.slice(from);
    out += value.slice(from, open);
    from = close + 1;
  }
}
