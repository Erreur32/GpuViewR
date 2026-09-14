// Minimal Apple XML plist parser — no external dependency (repo policy
// is zero deps beyond `ws`, cf. Docs/MACOS_AGENT.md §2.1). Used by the
// macOS powermetrics collector to decode `powermetrics -f plist` output.
//
// Handles the subset of the plist grammar that `powermetrics` actually
// emits: <dict>, <array>, <key>, <string>, <integer>, <real>, <true/>,
// <false/>, <date>, <data>. Dates/data are returned as their raw string
// content — the collector doesn't need them typed.

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue }
  | null;

interface Token {
  type: 'open' | 'close' | 'selfclose' | 'text';
  name?: string;
  text?: string;
}

const TAG_RE =
  /<([a-zA-Z][\w-]*)(?:\s+[^>]*)?\/>|<\/([a-zA-Z][\w-]*)>|<([a-zA-Z][\w-]*)(?:\s+[^>]*)?>|([^<]+)/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(xml))) {
    if (m[1]) tokens.push({ type: 'selfclose', name: m[1] });
    else if (m[2]) tokens.push({ type: 'close', name: m[2] });
    else if (m[3]) tokens.push({ type: 'open', name: m[3] });
    else if (m[4] && m[4].trim()) tokens.push({ type: 'text', text: decodeEntities(m[4]) });
  }
  return tokens;
}

interface Cursor {
  i: number;
}

function parseValue(tokens: Token[], cur: Cursor): PlistValue {
  const tok = tokens[cur.i];
  if (!tok) return null;

  if (tok.type === 'selfclose') {
    cur.i++;
    if (tok.name === 'true') return true;
    if (tok.name === 'false') return false;
    return null;
  }

  if (tok.type === 'open') {
    const name = tok.name as string;
    cur.i++;
    if (name === 'dict') return parseDict(tokens, cur);
    if (name === 'array') return parseArray(tokens, cur);

    let text = '';
    if (tokens[cur.i]?.type === 'text') {
      text = tokens[cur.i].text as string;
      cur.i++;
    }
    if (tokens[cur.i]?.type === 'close' && tokens[cur.i].name === name) cur.i++;

    if (name === 'integer') {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) ? n : 0;
    }
    if (name === 'real') {
      const n = Number.parseFloat(text);
      return Number.isFinite(n) ? n : 0;
    }
    return text;
  }

  // Unexpected close/text at value position — skip defensively rather
  // than throwing; powermetrics plist quirks shouldn't crash the agent.
  cur.i++;
  return null;
}

function parseDict(tokens: Token[], cur: Cursor): Record<string, PlistValue> {
  const obj: Record<string, PlistValue> = {};
  while (cur.i < tokens.length) {
    const tok = tokens[cur.i];
    if (tok.type === 'close' && tok.name === 'dict') {
      cur.i++;
      break;
    }
    if (tok.type === 'open' && tok.name === 'key') {
      cur.i++;
      let key = '';
      if (tokens[cur.i]?.type === 'text') {
        key = tokens[cur.i].text as string;
        cur.i++;
      }
      if (tokens[cur.i]?.type === 'close' && tokens[cur.i].name === 'key') cur.i++;
      obj[key] = parseValue(tokens, cur);
    } else {
      cur.i++;
    }
  }
  return obj;
}

function parseArray(tokens: Token[], cur: Cursor): PlistValue[] {
  const arr: PlistValue[] = [];
  while (cur.i < tokens.length) {
    const tok = tokens[cur.i];
    if (tok.type === 'close' && tok.name === 'array') {
      cur.i++;
      break;
    }
    arr.push(parseValue(tokens, cur));
  }
  return arr;
}

/** Parses one `<?xml ...?><!DOCTYPE ...><plist ...>...</plist>` document
 *  (one `powermetrics -f plist` sample, minus its trailing NUL byte) into
 *  a plain JS value — typically a `Record<string, PlistValue>`. */
export function parsePlistDocument(xml: string): PlistValue {
  const cleaned = xml
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .trim();
  const tokens = tokenize(cleaned);
  const cur: Cursor = { i: 0 };
  if (tokens[cur.i]?.type === 'open' && tokens[cur.i].name === 'plist') cur.i++;
  return parseValue(tokens, cur);
}
