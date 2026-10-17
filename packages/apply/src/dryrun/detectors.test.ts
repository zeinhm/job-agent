import { describe, expect, it } from "vitest";
import { classifyElement, frameKindOf, type CaptchaElementFacts } from "./detectors.ts";

const facts = (over: Partial<CaptchaElementFacts>): CaptchaElementFacts => ({
  tag: "div",
  src: "",
  className: "",
  size: "",
  appearance: "",
  inBadge: false,
  hasFrameChild: false,
  opacityHidden: false,
  scrollX: 0,
  scrollY: 0,
  ...over,
});

describe("frameKindOf (vendor frame URL shapes)", () => {
  it.each([
    ["https://www.google.com/recaptcha/api2/bframe?hl=en&k=x", "challenge"],
    ["https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x", "challenge"],
    ["https://www.google.com/recaptcha/api2/anchor?k=x&size=normal", "checkbox"],
    ["https://www.google.com/recaptcha/api2/anchor?k=x&size=compact", "checkbox"],
    ["https://www.google.com/recaptcha/enterprise/anchor?k=x&size=invisible", "invisible"],
    ["https://www.google.com/recaptcha/api2/other", "unknown"],
    [
      "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox&id=1",
      "checkbox",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
      "challenge",
    ],
    [
      "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox-invisible",
      "invisible",
    ],
    ["https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html", "unknown"],
    [
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x",
      "turnstile",
    ],
    ["https://example.test/frame", "unknown"],
  ])("%s -> %s", (url, kind) => {
    expect(frameKindOf(url)).toBe(kind);
  });
});

describe("classifyElement", () => {
  const bframe = "https://www.google.com/recaptcha/api2/bframe?k=x";
  const anchor = (size: string) => `https://www.google.com/recaptcha/api2/anchor?k=x&size=${size}`;

  it("a script is passive", () => {
    expect(classifyElement(facts({ tag: "script", src: "https://x.test/a.js" }), true)).toEqual({
      kind: "passive",
      label: "script",
    });
  });
  it("the badge is passive, even when visible", () => {
    expect(classifyElement(facts({ className: "grecaptcha-badge" }), true)).toEqual({
      kind: "passive",
      label: "badge",
    });
    expect(
      classifyElement(facts({ tag: "iframe", src: anchor("normal"), inBadge: true }), true),
    ).toEqual({
      kind: "passive",
      label: "badge",
    });
  });
  it("an iframe that is not visible is passive, whatever it is", () => {
    for (const src of [bframe, anchor("normal"), "https://www.google.com/recaptcha/api2/other"]) {
      expect(classifyElement(facts({ tag: "iframe", src }), false)).toEqual({
        kind: "passive",
        label: "hidden-frame",
      });
    }
  });
  it("a visible challenge or checkbox frame stops", () => {
    for (const src of [
      bframe,
      anchor("normal"),
      "https://newassets.hcaptcha.com/x/hcaptcha.html#frame=checkbox",
      "https://newassets.hcaptcha.com/x/hcaptcha.html#frame=challenge",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/x",
    ]) {
      expect(classifyElement(facts({ tag: "iframe", src }), true)).toEqual({
        kind: "stop",
        failSafe: false,
      });
    }
  });
  it("a visible invisible-mode frame is passive", () => {
    expect(classifyElement(facts({ tag: "iframe", src: anchor("invisible") }), true)).toEqual({
      kind: "passive",
      label: "invisible-widget",
    });
  });
  it("fail safe: a visible frame of an unknown kind stops", () => {
    expect(
      classifyElement(
        facts({ tag: "iframe", src: "https://www.google.com/recaptcha/api2/other" }),
        true,
      ),
    ).toEqual({ kind: "stop", failSafe: true });
  });
  it("invisible-mode containers are passive; a button bound to reCAPTCHA is too", () => {
    for (const over of [
      { className: "g-recaptcha", size: "invisible" },
      { className: "h-captcha", size: "invisible" },
      { className: "cf-turnstile", appearance: "execute" },
      { className: "cf-turnstile", appearance: "interaction-only" },
      { tag: "button", className: "g-recaptcha" },
      { tag: "input", className: "g-recaptcha" },
    ]) {
      expect(classifyElement(facts(over), true)).toEqual({
        kind: "passive",
        label: "invisible-widget",
      });
    }
  });
  it("a container with a frame is decided by the frame", () => {
    expect(classifyElement(facts({ className: "g-recaptcha", hasFrameChild: true }), true)).toEqual(
      {
        kind: "none",
      },
    );
  });
  it("fail safe: a visible-size container with no frame stops; an unsized one is unrendered", () => {
    expect(classifyElement(facts({ className: "g-recaptcha" }), true)).toEqual({
      kind: "stop",
      failSafe: true,
    });
    expect(classifyElement(facts({ className: "h-captcha" }), false)).toEqual({
      kind: "passive",
      label: "unrendered-container",
    });
  });
});
