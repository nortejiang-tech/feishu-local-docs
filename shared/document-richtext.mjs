/**
 * Pure decoder for captured Feishu attributed rich text.
 *
 * Contract (captured, uninterpreted):
 *   {
 *     text:       { segmentNumber: string },
 *     attribs:    { segmentNumber: operationString },
 *     attributes: { base10PoolId: [formatName, stringValue] },
 *     encoding:   "feishu-attributed-text-uninterpreted"
 *   }
 *
 * Operation stream syntax (repeated):
 *   (*BASE36_ATTR_ID)* (|BASE36_LINE_COUNT)? +BASE36_UTF16_LENGTH
 *
 * Returns { content, issues } where content is an array of Tiptap-style inline
 * nodes ({ type: "text", text, marks? }) and issues is an array of stable string
 * codes. No DOM, no HTML, no eval, no imports, no input mutation.
 */

const MAX_SEGMENTS = 10000;
const MAX_OPS_PER_SEGMENT = 10000;
const MAX_TOTAL_TEXT = 8 * 1024 * 1024;
const MAX_FONT_SIZE = 400;
const MAX_FONT_FAMILY = 128;
const MAX_ISSUES = 500;

const BOOL_ATTRS = {
  bold: "bold",
  strong: "bold",
  italic: "italic",
  em: "italic",
  underline: "underline",
  u: "underline",
  strikethrough: "strike",
  strike: "strike",
  "strike-through": "strike",
  "line-through": "strike",
  code: "code"
};

const COLOR_ATTRS = new Set([
  "textcolor",
  "text-color",
  "color", "texthighlight", "text-highlight"
]);

const BACKGROUND_ATTRS = new Set([
  "texthighlightcolor",
  "text-highlight-color",
  "text-background-color",
  "background-color",
  "texthighlightbackground",
  "text-highlight-background"
]);

const FONT_SIZE_ATTRS = new Set(["fontsize", "font-size"]);
const FONT_FAMILY_ATTRS = new Set(["fontfamily", "font-family"]);

/* Names that are captured but deliberately not rendered as styles. */
const IGNORED_NAMES = new Set([
  "author",
  "comment",
  "commentid",
  "comment-id",
  "commentref",
  "comment-ref",
  "mention",
  "user",
  "userid",
  "user-id",
  "revision",
  "revisionid",
  "timestamp",
  "anchor",
  "uuid",
  "id",
  "ref",
  "reference"
]);

const UNSUPPORTED_NAMES = new Set([
  "link",
  "href",
  "url",
  "hyperlink",
  "a",
  "subscript",
  "sub",
  "superscript",
  "sup"
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_FAMILY_CHARS = /[;{}<>]/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeReporter() {
  const issues = [];
  const seen = new Set();
  return {
    issues,
    add(code) {
      if (seen.has(code)) return;
      seen.add(code);
      if (issues.length < MAX_ISSUES) issues.push(code);
    }
  };
}

function textNode(text, marks) {
  const node = { type: "text", text };
  if (marks && marks.length) node.marks = marks;
  return node;
}

function plainContent(text) {
  return text === "" ? [] : [textNode(text)];
}

function normalizeKey(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, "");
}

function truthy(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return v === "true" || v === "1";
}

function falsy(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return v === "false" || v === "0";
}

function toHex(n) {
  return n.toString(16).padStart(2, "0");
}

/**
 * Validate/normalize a colour. Returns "#rrggbb", "rgba(r,g,b,a)" or null.
 */
function normalizeColor(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1].toLowerCase();
    if (digits.length === 3) {
      return (
        "#" +
        digits[0] +
        digits[0] +
        digits[1] +
        digits[1] +
        digits[2] +
        digits[2]
      );
    }
    return "#" + digits;
  }

  const fn =
    /^rgba?\(\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)(?:\s*,\s*([0-9]*\.?[0-9]+)\s*)?\)$/i.exec(
      value
    );
  if (!fn) return null;

  const parts = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;

  if (/^rgba\(/i.test(value) !== (fn[4] !== undefined)) return null;
  const integral=parts.every(Number.isInteger);
  if (fn[4] === undefined) {
    return integral ? "#" + parts.map(toHex).join("") : `rgb(${parts.join(',')})`;
  }

  const alpha = Number(fn[4]);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  if (alpha === 1 && integral) return "#" + parts.map(toHex).join("");
  return `rgba(${parts.join(',')},${alpha})`;
}

/**
 * Validate/normalize a font size. Returns "<n>px" / "<n>pt" or null.
 */
function normalizeFontSize(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const match = /^([0-9]+(?:\.[0-9]+)?)(px|pt)?$/i.exec(value);
  if (!match) return null;

  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0 || num > MAX_FONT_SIZE) return null;

  const suffix = match[2] ? match[2].toLowerCase() : "px";
  return `${num}${suffix}`;
}

/**
 * Validate a font family into a bounded inert string.
 */
function normalizeFontFamily(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (CONTROL_CHARS.test(value)) return null;
  if (FORBIDDEN_FAMILY_CHARS.test(value)) return null;
  if (/url\s*\(/i.test(value)) return null;
  if (value.length > MAX_FONT_FAMILY) return null;
  return value;
}

/**
 * Turn one captured attribute entry into style properties.
 * Returns { props, issue } — issue set when the format is unsupported/invalid.
 */
function interpretAttribute(entry) {
  if (!Array.isArray(entry) || entry.length < 2) {
    return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
  }
  const name = normalizeKey(entry[0]);
  const raw = entry[1];

  if (!name) return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
  if (IGNORED_NAMES.has(name)) return { props: null, issue: null };
  if (UNSUPPORTED_NAMES.has(name)) {
    return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
  }

  if (Object.prototype.hasOwnProperty.call(BOOL_ATTRS, name)) {
    const mark = BOOL_ATTRS[name];
    if (truthy(raw)) return { props: { mark: { type: mark } }, issue: null };
    if (falsy(raw)) return { props: null, issue: null };
    return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
  }

  if (COLOR_ATTRS.has(name)) {
    const color = normalizeColor(raw);
    if (!color) return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
    return { props: { style: { color } }, issue: null };
  }

  if (BACKGROUND_ATTRS.has(name)) {
    const color = normalizeColor(raw);
    if (!color) return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
    return { props: { style: { backgroundColor: color } }, issue: null };
  }

  if (FONT_SIZE_ATTRS.has(name)) {
    const size = normalizeFontSize(raw);
    if (!size) return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
    return { props: { style: { fontSize: size } }, issue: null };
  }

  if (FONT_FAMILY_ATTRS.has(name)) {
    const family = normalizeFontFamily(raw);
    if (!family) return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
    return { props: { style: { fontFamily: family } }, issue: null };
  }

  return { props: null, issue: "RICH_TEXT_FORMAT_UNSUPPORTED" };
}

function buildPool(attributes, reporter) {
  const pool = new Map();
  if (!isPlainObject(attributes)) return pool;

  const keys = Object.keys(attributes);
  if (keys.length > MAX_SEGMENTS) {
    reporter.add("RICH_TEXT_LIMIT_EXCEEDED");
  }

  const limited = keys.slice(0, MAX_SEGMENTS);
  for (const key of limited) {
    if (!/^[0-9]+$/.test(key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const result = interpretAttribute(attributes[key]);
    if (result.issue) reporter.add(result.issue);
    if (result.props) pool.set(index, result.props);
  }
  return pool;
}

function parseOps(ops, pool, reporter) {
  const runs = [];
  let position = 0;
  function integer() {
    const start = position;
    while (position < ops.length && /[0-9a-z]/i.test(ops[position])) position++;
    if (position === start) return null;
    const value = parseInt(ops.slice(start, position), 36);
    return Number.isSafeInteger(value) ? value : null;
  }
  while (position < ops.length) {
    if (runs.length >= MAX_OPS_PER_SEGMENT) {
      reporter.add('RICH_TEXT_LIMIT_EXCEEDED'); return null;
    }
    const attrIds = [];
    while (ops[position] === '*') {
      position++;
      const value = integer();
      if (value === null || attrIds.length >= MAX_SEGMENTS) return null;
      attrIds.push(value);
    }
    if (ops[position] === '|') {
      position++;
      const count = integer();
      if (count === null || count < 1) return null;
    }
    if (ops[position] !== '+') return null;
    position++;
    const length = integer();
    if (length === null || length < 1) return null;
    runs.push({attrIds, length});
  }
  return runs.length ? runs : null;
}

function buildMarks(propsList) {
  const marks = [];
  const style = {};
  let hasStyle = false;

  for (const props of propsList) {
    if (!props) continue;
    if (props.mark) {
      if (!marks.some((m) => m.type === props.mark.type)) {
        marks.push({ type: props.mark.type });
      }
    }
    if (props.style) {
      for (const [key, value] of Object.entries(props.style)) {
        style[key] = value;
        hasStyle = true;
      }
    }
  }

  if (hasStyle) {
    marks.push({ type: "textStyle", attrs: style });
  }
  return marks;
}

function mergeNodes(nodes) {
  const merged = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (
      last &&
      JSON.stringify(last.marks || null) === JSON.stringify(node.marks || null)
    ) {
      last.text += node.text;
    } else {
      merged.push({ type: "text", text: node.text, marks: node.marks });
    }
  }
  for (const node of merged) {
    if (!node.marks || !node.marks.length) delete node.marks;
  }
  return merged;
}

function segmentKeys(source) {
  if (!isPlainObject(source)) return [];
  return Object.keys(source)
    .filter((key) => /^[0-9]+$/.test(key))
    .map((key) => Number(key))
    .filter((n) => Number.isSafeInteger(n) && n >= 0)
    .sort((a, b) => a - b);
}

function fallback(plainText, reporter, code) {
  if (code) reporter.add(code);
  return { content: plainContent(plainText), issues: reporter.issues };
}

export function decodeFeishuRichText(rich, plainText) {
  const reporter = makeReporter();
  const fallbackText = typeof plainText === "string" ? plainText : "";

  if (!isPlainObject(rich)) {
    return { content: plainContent(fallbackText), issues: reporter.issues };
  }

  const textSource = isPlainObject(rich.text) ? rich.text : {};
  const attribsSource = isPlainObject(rich.attribs) ? rich.attribs : {};

  if (Object.keys(textSource).some(key => !/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)))) {
    return fallback(fallbackText, reporter, "RICH_TEXT_RUNS_INVALID");
  }
  const keys = segmentKeys(textSource);
  if (keys.length > MAX_SEGMENTS) {
    reporter.add("RICH_TEXT_LIMIT_EXCEEDED");
  }

  const pool = buildPool(rich.attributes, reporter);

  const nodes = [];
  let total = 0;
  let limitHit = false;
  let runsInvalid = false;

  for (const key of keys.slice(0, MAX_SEGMENTS)) {
    const raw = textSource[key];
    const segText = typeof raw === "string" ? raw : "";
    const segLen = segText.length;

    total += segLen;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_TEXT) {
      limitHit = true;
      break;
    }

    const opsRaw = attribsSource[key];
    if (segLen === 0) continue;

    if (typeof opsRaw !== "string" || opsRaw.length === 0) {
      reporter.add("RICH_TEXT_RUNS_UNAVAILABLE");
      nodes.push(textNode(segText));
      continue;
    }

    const runs = parseOps(opsRaw, pool, reporter);
    if (!runs) {
      runsInvalid = true;
      nodes.push(textNode(segText));
      continue;
    }


    let consumed = 0;
    let ok = true;
    const segNodes = [];

    for (const run of runs) {
      if (consumed + run.length > segLen) {
        ok = false;
        break;
      }
      const chunk = segText.slice(consumed, consumed + run.length);
      consumed += run.length;

      const propsList = (run.attrIds || [])
        .map((id) => pool.get(id))
        .filter(Boolean);
      segNodes.push(textNode(chunk, buildMarks(propsList)));
    }

    if (!ok || consumed !== segLen) {
      runsInvalid = true;
      nodes.push(textNode(segText));
      continue;
    }

    for (const node of segNodes) nodes.push(node);
  }

  if (limitHit) {
    return fallback(fallbackText, reporter, "RICH_TEXT_LIMIT_EXCEEDED");
  }
  if (runsInvalid) {
    reporter.add("RICH_TEXT_RUNS_INVALID");
  }

  const merged = mergeNodes(nodes);
  const combined = merged.map((n) => n.text).join("");
  if (combined !== fallbackText) {
    return fallback(fallbackText, reporter, "RICH_TEXT_RUNS_INVALID");
  }

  return { content: merged, issues: reporter.issues };
}

export default decodeFeishuRichText;
