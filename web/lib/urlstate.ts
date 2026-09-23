"use client";

/**
 * View state in the address bar, so the back button means what it looks like it means.
 *
 * The studio is a tool you navigate: you look at a family on the canvas, open a concept to
 * edit it, and then want to be back where you were — same family, same card selected. Held
 * in `useState` alone, that state is invisible to the browser, so Back leaves the page
 * entirely and returns you to whatever you were doing before the studio, and a screen worth
 * showing someone else cannot be linked at all. Both complaints are the same missing thing:
 * the URL does not say what you are looking at.
 *
 * Three decisions, because each one has a failure mode that is easy to ship:
 *
 * 1. **Query parameters, not a hash and not a route.** The site is a static export served
 *    by Apache from `public/`, so `/graph/?v=inspect&c=basic-whip` is the same file as
 *    `/graph/` with no rewrite rule, while a real route per concept would mean 218
 *    prerendered pages of an editing tool nobody should reach from a search engine. A hash
 *    would work too and read worse when pasted.
 *
 * 2. **Defaults are omitted, and absence is meaningful.** A field whose `write` returns
 *    `null` leaves no parameter behind, so the tool's front door stays `/graph/` instead of
 *    `/graph/?v=canvas&f=whips&only=0`. The inverse matters more: `parse` is handed `null`
 *    when a parameter is missing and decides what that means. For a selection, missing
 *    means *nothing selected* — not "keep whatever was selected before" — which is what
 *    makes Back out of a selection actually clear it.
 *
 * 3. **One owner per page.** `encodeState` builds the search string from its own fields only, so
 *    two components sharing a URL would each drop the other's parameters on every write.
 *    The page-level component holds the state and passes the parts its children need; this
 *    hook is deliberately not a context or a store, so there is nowhere to put a second
 *    owner by accident.
 *
 * Push versus replace is the caller's decision and the thing to get right. Push for a
 * change of what you are looking at — a view, a family, opening a concept. Replace for
 * refining the current screen — moving the selection, typing in a filter. The canvas moves
 * its selection with `j`/`k`, and pushing there would bury the previous screen under thirty
 * history entries and make Back useless in exactly the case this hook exists for.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type Mode = "push" | "replace";

export type Field<V> = {
  /** The parameter name. Short: these URLs get pasted into chat. */
  param: string;
  /** `raw` is `null` when the parameter is absent, and what that means is per field. */
  parse: (raw: string | null) => V;
  /** Return `null` to leave the parameter out — that is what keeps a clean URL clean. */
  write: (value: V) => string | null;
};

export type Spec<T> = { [K in keyof T]: Field<T[K]> };

/** A one-of-these-strings field, falling back to `fallback` for absent or unknown values. */
export function oneOf<V extends string>(param: string, allowed: readonly V[], fallback: V): Field<V> {
  return {
    param,
    parse: (raw) => (raw && (allowed as readonly string[]).includes(raw) ? (raw as V) : fallback),
    write: (value) => (value === fallback ? null : value),
  };
}

/** A free-text field. Absent means empty, and empty writes nothing. */
export function text(param: string): Field<string> {
  return {
    param,
    parse: (raw) => raw ?? "",
    write: (value) => value || null,
  };
}

/** An off-by-default flag, written as `1` so the URL stays short. */
export function flag(param: string): Field<boolean> {
  return {
    param,
    parse: (raw) => raw === "1",
    write: (value) => (value ? "1" : null),
  };
}

/**
 * State -> search string, and back. Module level and exported so they can be tested without
 * a DOM: every bug this file can have that is not "the browser did something else" lives in
 * these two functions.
 */
export function encodeState<T extends object>(spec: Spec<T>, state: T): string {
  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(spec) as [keyof T, Field<T[keyof T]>][]) {
    const raw = field.write(state[key]);
    if (raw !== null) params.set(field.param, raw);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function decodeState<T extends object>(spec: Spec<T>, search: string, base: T): T {
  const params = new URLSearchParams(search);
  const out = { ...base };
  for (const [key, field] of Object.entries(spec) as [keyof T, Field<T[keyof T]>][]) {
    out[key] = field.parse(params.get(field.param));
  }
  return out;
}

export function useUrlState<T extends object>(spec: Spec<T>, initial: T) {
  const [state, setState] = useState<T>(initial);

  // The current value, mirrored, because `go` has to compute the next URL and write history
  // synchronously. Doing that inside a `setState` updater would fire the history write twice
  // under StrictMode's double invocation, which is two entries per click and a Back button
  // that appears to do nothing on the first press.
  const at = useRef<T>(initial);
  // The spec is configuration, read once. A spec rebuilt every render is fine; one whose
  // *fields* change at runtime is not a thing this hook supports, and pinning it here says
  // so rather than half-working.
  const spec_ = useRef(spec);
  const base_ = useRef(initial);

  // Read the URL after mount rather than during render.
  //
  // The page is prerendered at build time, where there is no URL to read: rendering from
  // `window` would either throw on the server or hydrate with different markup than the
  // server produced. So the first paint is the defaults and the URL is applied immediately
  // after — one extra render on load, in exchange for a static export that still works.
  useEffect(() => {
    const fromUrl = () => {
      const next = decodeState(spec_.current, window.location.search, base_.current);
      at.current = next;
      setState(next);
    };
    fromUrl();
    window.addEventListener("popstate", fromUrl);
    return () => window.removeEventListener("popstate", fromUrl);
  }, []);

  const go = useCallback(
    (patch: Partial<T>, mode: Mode = "push") => {
      const next = { ...at.current, ...patch };
      at.current = next;
      setState(next);
      if (typeof window === "undefined") return;
      const search = encodeState(spec_.current, next);
      // Nothing to record when the URL would not change. Without this, clicking the tab you
      // are already on stacks identical entries and Back stops leaving the screen.
      if (search === window.location.search) return;
      const url = window.location.pathname + search;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [],
  );

  return [state, go] as const;
}
