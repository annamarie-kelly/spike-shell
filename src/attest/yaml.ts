// A deliberately small YAML reader for check sets.
//
// Why not a dependency: this repo carries no general-purpose runtime deps, and the Rust
// side already reads template manifests with serde_yaml. When the check-set loader moves
// into Tauri (it is the same file a marketplace template installs), serde_yaml takes over
// and this goes away. Until then a check set has to be editable by someone who is not
// going to write JSON by hand.
//
// Why strict: the alternative to a full parser is a lenient one, and a lenient parser
// guesses. A check set decides what "verified" means, so a guess here is a silently wrong
// verdict later. This reader supports exactly the subset a check set needs and throws,
// with a line number, on anything else - an unsupported file is visible, a misread one is
// not.
//
// Supported: block maps, block sequences, `- key: value` maps inside sequences, inline
// flow maps and sequences, comments, and scalars (plain, single- and double-quoted,
// numbers, booleans, null).
//
// Not supported, and rejected rather than approximated: anchors and aliases, tags,
// multi-line scalars (`|`, `>`), multiple documents, and complex keys.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

class YamlError extends Error {
  constructor(message: string, line: number) {
    super(`check set: ${message} (line ${line + 1})`);
  }
}

/** Strip a trailing comment, respecting quotes so a `#` inside a string survives. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split a flow body on commas at depth zero, respecting quotes and nesting. */
function splitFlow(body: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const c of body) {
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (depth !== 0 || quote) throw new YamlError('unclosed bracket or quote', lineNo);
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('!'))
    throw new YamlError('anchors, aliases and tags are not supported', lineNo);
  if (s === '|' || s === '>' || s.startsWith('|') || s.startsWith('>'))
    throw new YamlError('multi-line scalars are not supported', lineNo);

  // An opener with no matching close is a truncated flow collection, not a plain string.
  // Falling through to the scalar branch would silently turn `{ type: folder, path: ./x`
  // into a string and load a check set that means something other than what was written.
  if ((s.startsWith('{') && !s.endsWith('}')) || (s.startsWith('[') && !s.endsWith(']'))) {
    throw new YamlError('unclosed bracket', lineNo);
  }

  if (s.startsWith('{') && s.endsWith('}')) {
    const out: { [k: string]: YamlValue } = {};
    for (const part of splitFlow(s.slice(1, -1), lineNo)) {
      const colon = splitKey(part, lineNo);
      out[colon.key] = parseScalar(colon.rest, lineNo);
    }
    return out;
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1), lineNo).map((p) => parseScalar(p, lineNo));
  }
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
      (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

/** Split `key: rest` at the first top-level colon. Throws when there is none. */
function splitKey(text: string, lineNo: number): { key: string; rest: string } {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0 && (i + 1 >= text.length || /[\s]/.test(text[i + 1]))) {
      return { key: text.slice(0, i).trim().replace(/^['"]|['"]$/g, ''), rest: text.slice(i + 1).trim() };
    }
  }
  throw new YamlError(`expected \`key: value\`, got \`${text.trim()}\``, lineNo);
}

type Line = { indent: number; text: string; no: number };

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (!first) return { value: null, next: start };

  if (first.text.startsWith('- ') || first.text === '-') {
    const seq: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const body = lines[i].text.slice(1).trim();
      if (body === '') {
        const nested = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 1);
        seq.push(nested.value);
        i = nested.next;
        continue;
      }
      // `- key: value` starts a map whose further keys are indented past the dash.
      let isMap = false;
      try {
        splitKey(body, lines[i].no);
        isMap = !(body.startsWith('{') || body.startsWith('['));
      } catch {
        isMap = false;
      }
      if (isMap) {
        const { key, rest } = splitKey(body, lines[i].no);
        const map: { [k: string]: YamlValue } = {};
        if (rest === '') {
          const nested = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 1);
          map[key] = nested.value;
          i = nested.next;
        } else {
          map[key] = parseScalar(rest, lines[i].no);
          i += 1;
        }
        const inner = indent + 2;
        while (i < lines.length && lines[i].indent >= inner && !lines[i].text.startsWith('- ')) {
          const sub = parseBlock(lines, i, lines[i].indent);
          Object.assign(map, sub.value as object);
          i = sub.next;
        }
        seq.push(map);
        continue;
      }
      seq.push(parseScalar(body, lines[i].no));
      i += 1;
    }
    return { value: seq, next: i };
  }

  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { key, rest } = splitKey(lines[i].text, lines[i].no);
    // A duplicate key silently overwriting is how a second pasted `checks:` block loses
    // every entry in the first one. Real YAML loaders reject this; so does this one.
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlError(`duplicate key \`${key}\``, lines[i].no);
    }
    if (rest === '') {
      const childIndent = lines[i + 1]?.indent ?? -1;
      if (childIndent > indent || (childIndent === indent && lines[i + 1]?.text.startsWith('- '))) {
        const nested = parseBlock(lines, i + 1, childIndent);
        map[key] = nested.value;
        i = nested.next;
        continue;
      }
      map[key] = null;
      i += 1;
      continue;
    }
    map[key] = parseScalar(rest, lines[i].no);
    i += 1;
  }
  return { value: map, next: i };
}

export function parseYaml(source: string): YamlValue {
  if (/^---\s*$/m.test(source.trim().split('\n').slice(1).join('\n')))
    throw new YamlError('multiple documents are not supported', 0);

  const lines: Line[] = [];
  source.split('\n').forEach((raw, no) => {
    const noComment = stripComment(raw);
    if (!noComment.trim()) return;
    if (noComment.trim() === '---') return;
    if (/\t/.test(noComment.replace(/[^\t]*$/, '')))
      throw new YamlError('tabs are not valid YAML indentation', no);
    lines.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim(), no });
  });
  if (!lines.length) return {};
  const { value, next } = parseBlock(lines, 0, lines[0].indent);

  // Every line must have been consumed. Both block loops stop the moment an indent does
  // not match exactly, so ONE stray space silently discarded the whole remainder of the
  // file - checks, thresholds and on_fail included - and the run then enforced less than
  // the file on screen said, with no error anywhere. A parser that drops input is worse
  // than one that refuses it, which is the whole premise of this module.
  if (next < lines.length) {
    throw new YamlError(
      `unexpected indentation; this line does not line up with the block above it`,
      lines[next].no,
    );
  }
  return value;
}
