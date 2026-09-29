/**
 * Utility for quoting arguments for Windows PowerShell.
 *
 * PowerShell supports Unicode smart quotes as single-quote delimiters:
 *   - ' (U+0027, Apostrophe)
 *   - ‘ (U+2018, Left Single Quotation Mark)
 *   - ’ (U+2019, Right Single Quotation Mark)
 *   - ‚ (U+201A, Single Low-9 Quotation Mark)
 *   - ‛ (U+201B, Single High-Reversed-9 Quotation Mark)
 *
 * If untrusted input containing any of these characters is interpolated into a
 * single-quoted string without escaping, an attacker can break out of the string
 * and execute arbitrary PowerShell commands.
 */

export const PS_SINGLE_QUOTE_CHARS = /['\u2018\u2019\u201A\u201B]/g;

/**
 * Escape a string for safe interpolation inside a PowerShell single-quoted literal.
 * Rejects strings containing NUL or newlines to prevent command splitting.
 * Doubles all single-quote variants recognized by PowerShell.
 */
export function psQuote(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`psQuote expects a string, received ${typeof value}`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Invalid character in command argument: NUL or newline detected");
  }
  const escaped = value.replace(PS_SINGLE_QUOTE_CHARS, (m) => m + m);
  return `'${escaped}'`;
}
