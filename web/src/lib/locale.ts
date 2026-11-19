/**
 * The locale every date and time in the UI is formatted with: the one `Intl` resolves by default,
 * which follows the system's regional settings. `navigator.languages` is deliberately not used:
 * privacy-hardened browsers report "en-US" there whatever the user's region (seen: "en-US" in
 * navigator.languages, "en-DE" from Intl). There is no app language setting; add one here.
 */
export const UI_LOCALE: string = new Intl.DateTimeFormat().resolvedOptions().locale;

/** True when the locale writes times with am/pm. */
export const UI_HOUR12: boolean = (() => {
  const cycle = new Intl.DateTimeFormat(UI_LOCALE, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12";
})();
