import test from "node:test";
import assert from "node:assert/strict";
import { decodeFeishuRichText } from "../shared/document-richtext.mjs";

function texts(content) {
  return content.map((n) => n.text).join("");
}

function marksOf(content, index = 0) {
  return (content[index] && content[index].marks) || [];
}

function styleOf(content, index = 0) {
  const ts = marksOf(content, index).find((m) => m.type === "textStyle");
  return ts ? ts.attrs : {};
}

test("non-object input returns plain fallback without issues", () => {
  const r = decodeFeishuRichText(null, "hello");
  assert.deepEqual(r.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(r.issues, []);
});

test("numeric segment order with base36 attr id a -> decimal 10 bold", () => {
  const rich = {
    text: { 0: "ab", 1: "cd" },
    attribs: { 0: "*A+2", 1: "+2" },
    attributes: { 10: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.equal(texts(r.content), "abcd");
  assert.deepEqual(marksOf(r.content, 0), [{ type: "bold" }]);
  assert.equal(marksOf(r.content, 1).length, 0);
  assert.deepEqual(r.issues, []);
});

test("runs are independent, attributes not inherited", () => {
  const rich = {
    text: { 0: "abcd" },
    attribs: { 0: "*1+2+2" },
    attributes: { 1: ["italic", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.equal(r.content.length, 2);
  assert.deepEqual(marksOf(r.content, 0), [{ type: "italic" }]);
  assert.equal(marksOf(r.content, 1).length, 0);
});

test("multiple attributes on one run collapse into a single textStyle mark", () => {
  const rich = {
    text: { 0: "xy" },
    attribs: { 0: "*1*2*3+2" },
    attributes: {
      1: ["bold", "true"],
      2: ["textColor", "#ff0000"],
      3: ["font-size", "12px"]
    },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "xy");
  assert.equal(r.content.length, 1);
  const marks = marksOf(r.content, 0);
  assert.deepEqual(marks.map((m) => m.type).sort(), ["bold", "textStyle"]);
  assert.deepEqual(styleOf(r.content, 0), { color: "#ff0000", fontSize: "12px" });
});

test("chinese and surrogate pairs counted as UTF-16 units", () => {
  const seg = "中👍文";
  assert.equal(seg.length, 4);
  const rich = {
    text: { 0: seg },
    attribs: { 0: "*1+4" },
    attributes: { 1: ["underline", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, seg);
  assert.equal(texts(r.content), seg);
  assert.deepEqual(marksOf(r.content, 0), [{ type: "underline" }]);
  assert.deepEqual(r.issues, []);
});

test("line count token is accepted and ignored", () => {
  const rich = {
    text: { 0: "abc" },
    attribs: { 0: "|2+3" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abc");
  assert.equal(texts(r.content), "abc");
  assert.deepEqual(r.issues, []);
});

test("unknown filtered metadata is harmless", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+2" },
    attributes: { 1: ["author", "someone"], 2: ["comment-id", "c-9"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.equal(texts(r.content), "ab");
  assert.equal(r.content[0].marks, undefined);
  assert.deepEqual(r.issues, []);
});

test("false booleans produce no mark and no issue", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1*2+2" },
    attributes: { 1: ["bold", "false"], 2: ["italic", "0"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.equal(r.content[0].marks, undefined);
  assert.deepEqual(r.issues, []);
});

test("safe rgb normalized to hex, rgba kept with alpha", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+1*2+1" },
    attributes: {
      1: ["color", "rgb(255, 128, 0)"],
      2: ["textHighlightColor", "rgba(1,2,3,0.5)"]
    },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.deepEqual(styleOf(r.content, 0), { color: "#ff8000" });
  assert.deepEqual(styleOf(r.content, 1), {
    backgroundColor: "rgba(1,2,3,0.5)"
  });
  assert.deepEqual(r.issues, []);
});

test("shorthand hex expanded", () => {
  const rich = {
    text: { 0: "a" },
    attribs: { 0: "*1+1" },
    attributes: { 1: ["text-color", "#0af"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "a");
  assert.deepEqual(styleOf(r.content, 0), { color: "#00aaff" });
});

test("invalid colors reported and text kept unstyled", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+1*2+1" },
    attributes: {
      1: ["color", "not-a-color"],
      2: ["background-color", "rgb(999,0,0)"]
    },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.equal(texts(r.content), "ab");
  assert.equal(r.content[0].marks, undefined);
  assert.deepEqual(r.issues, ["RICH_TEXT_FORMAT_UNSUPPORTED"]);
});

test("link and superscript are unsupported formats", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1*2+2" },
    attributes: {
      1: ["link", "https://example.com"],
      2: ["superscript", "true"]
    },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.equal(texts(r.content), "ab");
  assert.equal(r.content[0].marks, undefined);
  assert.deepEqual(r.issues, ["RICH_TEXT_FORMAT_UNSUPPORTED"]);
});

test("font size bounds and font family sanitising", () => {
  const rich = {
    text: { 0: "abcd" },
    attribs: { 0: "*1+1*2+1*3+1*4+1" },
    attributes: {
      1: ["fontSize", "12"],
      2: ["font-size", "400pt"],
      3: ["fontSize", "401px"],
      4: ["fontFamily", "Arial; {x}"]
    },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.deepEqual(styleOf(r.content, 0), { fontSize: "12px" });
  assert.deepEqual(styleOf(r.content, 1), { fontSize: "400pt" });
  assert.equal(r.content.length, 3);
  assert.equal(texts(r.content), "abcd");
  assert.deepEqual(r.issues, ["RICH_TEXT_FORMAT_UNSUPPORTED"]);
});

test("valid font family kept as inert bounded string", () => {
  const rich = {
    text: { 0: "a" },
    attribs: { 0: "*1+1" },
    attributes: { 1: ["font-family", "Helvetica Neue, Arial"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "a");
  assert.deepEqual(styleOf(r.content, 0), {
    fontFamily: "Helvetica Neue, Arial"
  });
  assert.deepEqual(r.issues, []);
});

test("adjacent runs with identical marks merge", () => {
  const rich = {
    text: { 0: "abcd" },
    attribs: { 0: "*1+2*1+2" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].text, "abcd");
});

test("malformed trailing operator falls back to plain segment text once", () => {
  const rich = {
    text: { 0: "ab", 1: "cd" },
    attribs: { 0: "*1+2+", 1: "*1+2" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.equal(texts(r.content), "abcd");
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_INVALID"]);
  assert.equal(r.content[0].marks, undefined);
  assert.equal(r.content[0].text, "ab");
});

test("overlong run length falls back", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+5" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.deepEqual(r.content, [{ type: "text", text: "ab" }]);
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_INVALID"]);
});

test("underlength runs fall back preserving text", () => {
  const rich = {
    text: { 0: "abcd" },
    attribs: { 0: "*1+2" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.deepEqual(r.content, [{ type: "text", text: "abcd" }]);
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_INVALID"]);
});

test("zero run length is invalid", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+0" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_INVALID"]);
  assert.equal(texts(r.content), "ab");
});

test("combined segment text mismatch returns plainText fallback", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "+2" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "zz");
  assert.deepEqual(r.content, [{ type: "text", text: "zz" }]);
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_INVALID"]);
});

test("missing attribs on nonempty segment records unavailable and keeps text", () => {
  const rich = {
    text: { 0: "ab", 1: "cd" },
    attribs: { 1: "+2" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcd");
  assert.equal(texts(r.content), "abcd");
  assert.deepEqual(r.issues, ["RICH_TEXT_RUNS_UNAVAILABLE"]);
  assert.equal(r.content[0].marks, undefined);
});

test("RICH_TEXT_RUNS_INVALID reported exactly once across segments", () => {
  const rich = {
    text: { 0: "ab", 1: "cd", 2: "ef" },
    attribs: { 0: "bogus", 1: "+9", 2: "+2" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "abcdef");
  assert.deepEqual(
    r.issues.filter((c) => c === "RICH_TEXT_RUNS_INVALID"),
    ["RICH_TEXT_RUNS_INVALID"]
  );
  assert.equal(texts(r.content), "abcdef");
});

test("empty segment text contributes nothing", () => {
  const rich = {
    text: { 0: "", 1: "ab" },
    attribs: { 1: "+2" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "ab");
  assert.deepEqual(r.content, [{ type: "text", text: "ab" }]);
  assert.deepEqual(r.issues, []);
});

test("no source mutation", () => {
  const rich = {
    text: { 0: "ab" },
    attribs: { 0: "*1+2" },
    attributes: { 1: ["bold", "true"] },
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const before = JSON.stringify(rich);
  decodeFeishuRichText(rich, "ab");
  assert.equal(JSON.stringify(rich), before);
});

test("output contains no html or eval-able markup", () => {
  const rich = {
    text: { 0: "<script>alert(1)</script>" },
    attribs: { 0: "+21" },
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const r = decodeFeishuRichText(rich, "<script>alert(1)</script>");
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
  assert.equal(r.content[0].text, "<script>alert(1)</script>");
});

test("limits are enforced without losing text", () => {
  const text = {};
  const attribs = {};
  const keys = [];
  for (let i = 0; i <= 10000; i += 1) keys.push(i);
  for (const k of keys) {
    text[k] = "a";
    attribs[k] = "+1";
  }
  const rich = {
    text,
    attribs,
    attributes: {},
    encoding: "feishu-attributed-text-uninterpreted"
  };
  const plain = keys.map(() => "a").join("");
  const r = decodeFeishuRichText(rich, plain);
  assert.ok(r.issues.includes("RICH_TEXT_LIMIT_EXCEEDED"));
  assert.equal(texts(r.content), plain);
});

for (const ops of ['+2*1', '+2|2', '|1*1+2', '|1|2+2', '*zzzzzzzzzzzzzzzz+2']) {
 test(`strict operation stream rejects ${ops}`, () => {
  const r=decodeFeishuRichText({text:{0:'ab'},attribs:{0:ops},attributes:{1:['bold','true']}},'ab');
  assert.deepEqual(r.content,[{type:'text',text:'ab'}]);
  assert.ok(r.issues.includes('RICH_TEXT_RUNS_INVALID'));
 });
}
test('native foreground and background aliases and fractional font size remain distinct',()=>{
 const r=decodeFeishuRichText({text:{0:'a'},attribs:{0:'*1*2*3+1'},attributes:{1:['textHighlight','rgb(36,91,219)'],2:['textHighlightBackground','rgba(255,246,122,0.8)'],3:['fontSize','12.5px']}},'a');
 assert.deepEqual(styleOf(r.content),{color:'#245bdb',backgroundColor:'rgba(255,246,122,0.8)',fontSize:'12.5px'});
 assert.deepEqual(r.issues,[]);
});
test('noncanonical segment keys fail without losing fallback text',()=>{
 const r=decodeFeishuRichText({text:{'01':'a',1:'b'},attribs:{1:'+1'},attributes:{}},'ab');
 assert.deepEqual(r.content,[{type:'text',text:'ab'}]);
 assert.ok(r.issues.includes('RICH_TEXT_RUNS_INVALID'));
});

test('fractional colors stay exact and rgba arity is strict',()=>{
 const decode=color=>decodeFeishuRichText({text:{0:'a'},attribs:{0:'*1+1'},attributes:{1:['textColor',color]}},'a');
 assert.equal(styleOf(decode('rgb(1.5,2,3)').content).color,'rgb(1.5,2,3)');
 assert.ok(decode('rgba(1,2,3)').issues.includes('RICH_TEXT_FORMAT_UNSUPPORTED'));
 assert.ok(decode('rgb(1,2,3,0.5)').issues.includes('RICH_TEXT_FORMAT_UNSUPPORTED'));
});
