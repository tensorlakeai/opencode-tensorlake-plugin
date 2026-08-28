/**
 * Compiles a glob pattern into a RegExp that matches a whole path, using the
 * same semantics as OpenCode's built-in glob tool:
 *
 *   *      any run of characters except `/`
 *   ?      one character except `/`
 *   **     any run of characters, `/` included
 *   [...]  a character class; a leading `!` or `^` negates it
 *   {a,b}  alternation, which may nest
 *
 * `/` separates path segments, so `*.ts` matches only the top level and
 * `src/**\/*.ts` is what descends. A `find -name` search cannot express this:
 * it matches the basename alone and treats `/` as an ordinary character.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  let braces = 0
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeLiteral(pattern[i + 1])
      i += 2
      continue
    }
    if (c === '*') {
      let j = i
      while (pattern[j] === '*') j++
      if (j - i >= 2) {
        // `**/` also matches zero directories, so `src/**/*.ts` finds src/a.ts.
        if (pattern[j] === '/') {
          out += '(?:.*/)?'
          j++
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      i = j
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (c === '[') {
      const cls = readCharClass(pattern, i)
      if (cls) {
        out += cls.regex
        i = cls.next
      } else {
        // Unterminated class: the bracket is just a bracket.
        out += '\\['
        i++
      }
      continue
    }
    if (c === '{') {
      out += '(?:'
      braces++
      i++
      continue
    }
    if (c === '}' && braces > 0) {
      out += ')'
      braces--
      i++
      continue
    }
    if (c === ',' && braces > 0) {
      out += '|'
      i++
      continue
    }
    out += escapeLiteral(c)
    i++
  }
  // Close any brace that was never closed, so the RegExp still compiles.
  while (braces-- > 0) out += ')'
  return new RegExp(`^${out}$`)
}

function readCharClass(pattern: string, start: number): { regex: string; next: number } | undefined {
  let j = start + 1
  let negated = false
  if (pattern[j] === '!' || pattern[j] === '^') {
    negated = true
    j++
  }
  let body = ''
  // A `]` in the first position is a literal, not the terminator.
  if (pattern[j] === ']') {
    body += '\\]'
    j++
  }
  while (j < pattern.length && pattern[j] !== ']') {
    const ch = pattern[j]
    body += ch === '\\' || ch === '^' || ch === '[' ? `\\${ch}` : ch
    j++
  }
  if (j >= pattern.length || body === '') return undefined
  return { regex: `[${negated ? '^' : ''}${body}]`, next: j + 1 }
}

/**
 * Splits off the leading path segments that contain no glob metacharacter.
 * The search can then start at that subdirectory instead of walking the whole
 * project: `src/**\/*.ts` only ever matches files under `src`.
 */
export function literalPrefix(pattern: string): string {
  if (pattern.startsWith('/')) return ''
  const segments = pattern.split('/')
  const literal: string[] = []
  // The last segment is the filename part, never a directory to descend into.
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}\\]/.test(segment) || segment === '' || segment === '..') break
    literal.push(segment)
  }
  return literal.join('/')
}

function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}
