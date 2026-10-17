// Shared by the CAPTCHA fixture variants (t_cbcbc227). Synthetic, no real data.
// Reports every interaction with a CAPTCHA element (anything inside [data-fixture-captcha]) and every call of a CAPTCHA API
// as a GET beacon to this fixture server (`/__captcha-hit/<what>`), so a test can prove the dry run touched none of them.
// Also reports every `change` event of the form as `/__field-change`, so a test can count how many fields were filled.
(() => {
  const beacon = (path) => {
    new Image().src = `${path}?${Math.random()}`;
  };
  const hit = (what) => beacon(`/__captcha-hit/${what}`);
  const inCaptcha = (t) => t instanceof Element && t.closest("[data-fixture-captcha]") !== null;
  const events = [
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mouseover",
    "mouseenter",
    "pointerdown",
    "pointerover",
    "pointerenter",
    "focus",
    "focusin",
    "keydown",
    "touchstart",
    "wheel",
  ];
  for (const name of events) {
    document.addEventListener(
      name,
      (e) => {
        if (inCaptcha(e.target)) hit(name);
      },
      true,
    );
  }
  document.addEventListener("change", () => beacon("/__field-change"), true);
  const api = (vendor, names) => {
    const o = {};
    for (const n of names) o[n] = () => hit(`api-${vendor}-${n}`);
    return o;
  };
  window.grecaptcha = api("grecaptcha", ["render", "execute", "reset", "getResponse", "ready"]);
  window.hcaptcha = api("hcaptcha", ["render", "execute", "reset", "getResponse"]);
  window.turnstile = api("turnstile", ["render", "execute", "reset", "getResponse"]);
})();
